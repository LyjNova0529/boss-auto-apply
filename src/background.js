// ===== BOSS自动投递 Service Worker：编排 收集→筛选→审核→投递 + DeepSeek =====
importScripts('/src/selectors.js'); // 让 SW 也能用 CITY_MAP（否则城市永远是全国）
const DS_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const DS_MODEL = 'deepseek-chat';

const RESUME_TEXT = ''; // 不内置任何个人简历，由用户在设置页"简历文字"填写

let state = {
  phase: 'idle', paused: false, aborted: false,
  jobs: [], screened: [], greetings: {}, results: [], processed: {}
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// ── 小工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
function log(text, level) { chrome.runtime.sendMessage({ type: 'LOG', text: text, level: level || 'info' }).catch(() => {}); }
function pushPhase() { chrome.runtime.sendMessage({ type: 'PHASE', phase: state.phase }).catch(() => {}); }
function progress(cur, total, label) { chrome.runtime.sendMessage({ type: 'PROGRESS', cur: cur, total: total, label: label || '' }).catch(() => {}); }
async function waitIfPaused() { while (state.paused && !state.aborted) await sleep(400); }
function getCfg() { return chrome.storage.local.get(['dsKey', 'resumeText', 'resumeImage', 'city', 'keyword', 'jobType', 'count', 'minSalary', 'blacklist']); }
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
function jobInfo(j) { return '岗位：' + (j.name || '') + '\n技能标签：' + ((j.tags || []).join('、')) + '\n薪资：' + (j.salary || '') + '\n公司：' + (j.company || ''); }
function findJob(id) { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === id) return state.jobs[i]; return null; }

// ── 规则过滤：最低薪资 + 黑名单（带否定语境识别）──
function parseMinSalaryK(salaryText) {
  const text = String(salaryText || '').replace(/\s/g, '').toLowerCase();
  if (!text || /面议/.test(text)) return null;
  const m = text.match(/(\d+(?:\.\d+)?)(?:-\d+(?:\.\d+)?)?k/);
  if (m) return parseFloat(m[1]);
  const yuan = text.match(/(\d{4,})(?:-\d{4,})?/);
  if (yuan) return Math.round((parseInt(yuan[1], 10) / 1000) * 10) / 10;
  return null;
}

function parseBlacklist(text) {
  return String(text || '')
    .split(/[\n,，、;；]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function normalizeForMatch(text) {
  return String(text || '').replace(/\s/g, '').toLowerCase();
}

function isNegatedContext(text, index, wordLength) {
  const before = text.slice(Math.max(0, index - 10), index);
  const after = text.slice(index + wordLength, Math.min(text.length, index + wordLength + 6));
  const around = before + text.slice(index, index + wordLength) + after;
  const negBefore = /(无|非|不含|不是|无需|无须|不用|不需要|不涉及|没有|没|拒绝)[\w\u4e00-\u9fa5]{0,6}$/;
  const negAround = /(无|非|不含|不是|无需|无须|不用|不需要|不涉及|没有|没|拒绝)[\w\u4e00-\u9fa5]{0,6}/;
  const negAfter = /^(性质|属性|要求|经验|压力|指标)?(少|低|弱|轻)?/;
  return negBefore.test(before) || (negAround.test(around) && negAfter.test(after));
}

function findBlacklistHit(job, words) {
  if (!words.length) return null;
  const fields = [
    { label: '岗位名称', text: job.name },
    { label: '公司名', text: job.company },
    { label: '标签', text: (job.tags || []).join('、') },
    { label: '薪资', text: job.salary }
  ];
  for (const field of fields) {
    const text = normalizeForMatch(field.text);
    if (!text) continue;
    for (const rawWord of words) {
      const word = normalizeForMatch(rawWord);
      if (!word) continue;
      let pos = text.indexOf(word);
      while (pos >= 0) {
        if (!isNegatedContext(text, pos, word.length)) {
          return { word: rawWord, field: field.label };
        }
        pos = text.indexOf(word, pos + word.length);
      }
    }
  }
  return null;
}

function applyRuleFilter(cfg, jobs) {
  const minSalary = parseFloat(cfg.minSalary);
  const hasMinSalary = Number.isFinite(minSalary) && minSalary > 0;
  const blacklist = parseBlacklist(cfg.blacklist);
  const passed = [];
  const filtered = [];

  for (const job of jobs) {
    if (hasMinSalary) {
      const jobMin = parseMinSalaryK(job.salary);
      if (jobMin !== null && jobMin < minSalary) {
        filtered.push(Object.assign({}, job, {
          match: false,
          filteredByRule: true,
          reason: '薪资下限 ' + jobMin + 'K 低于最低薪资 ' + minSalary + 'K'
        }));
        continue;
      }
    }

    const hit = findBlacklistHit(job, blacklist);
    if (hit) {
      filtered.push(Object.assign({}, job, {
        match: false,
        filteredByRule: true,
        reason: hit.field + '命中过滤词：' + hit.word
      }));
      continue;
    }

    passed.push(job);
  }

  return { passed: passed, filtered: filtered };
}

// ── DeepSeek ──
async function callDS(messages, maxTokens) {
  const cfg = await getCfg();
  if (!cfg.dsKey) throw new Error('未配置DeepSeek API Key');
  const resp = await fetch(DS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.dsKey },
    body: JSON.stringify({ model: DS_MODEL, messages: messages, max_tokens: maxTokens || 500, temperature: 0.5 })
  });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error('DeepSeek ' + resp.status + ': ' + t.slice(0, 120)); }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// 筛选：只判断是否值得投（用岗位标签快速判断，不生成招呼语）
async function screenJob(cfg, job) {
  const sys = '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·适中】保留(match=true)：岗位方向与求职者简历的专业/技能/经历相关，且求职者的经验年限、学历、级别够得着该岗位（不超纲）。剔除(match=false)：方向与简历明显无关；岗位要求的经验/学历/硬技能明显超出简历；岗位级别明显高于求职者当前水平。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"reason":"一句话理由"}';
  const user = '求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  const raw = await callDS([{ role: 'system', content: sys }, { role: 'user', content: user }], 200);
  let p = null;
  try { p = JSON.parse(raw); } catch (e) { const m = raw && raw.match(/\{[\s\S]*\}/); if (m) { try { p = JSON.parse(m[0]); } catch (e2) {} } }
  if (!p) return { match: false, reason: 'AI解析失败' };
  return { match: p.match === true, reason: p.reason || '' };
}

// 投递时：结合该岗位的【完整JD】+ 简历，现场生成专属招呼语
async function genGreetingFromJD(cfg, job, jd) {
  const sys = '你是求职者本人，在BOSS直聘给HR发招呼语。回复会原样发给HR，严禁任何注释、说明、括号备注、字数统计或引导语。\n【格式】1.开头前15字必须是"熟悉XXX、XXX"(填该JD要求且你简历具备的核心技能1-2个)。2.紧接"做过XXX"说明简历里与该岗位相关的具体项目/经历。3.全文80-120字，真诚自然。';
  const jdText = (jd && jd.trim()) ? jd.trim() : ('技能标签：' + (job.tags || []).join('、'));
  const user = '我的简历：\n' + resumeFull(cfg) + '\n\n目标岗位：' + (job.name || '') + (job.company ? ('（' + job.company + '）') : '') + '\n该岗位JD：\n' + jdText + '\n\n请按格式生成一段招呼语，开头必须"熟悉…"，直接输出招呼语本身，不要任何多余内容。';
  const raw = await callDS([{ role: 'system', content: sys }, { role: 'user', content: user }], 300);
  return (raw || '').trim();
}

// ── tab 注入 + 发消息 ──
async function ensureInjected(tabId, file) {
  try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/selectors.js', file] }); } catch (e) {}
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'no response' });
    });
  });
}
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    function lis(id, info) { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } }
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } });
  });
}
function normalizeCityName(name) {
  return (name || '')
    .trim()
    .replace(/^(中国|中华人民共和国)/, '')
    .replace(/(特别行政区|自治州|自治县|地区|盟|市|省|县|区)$/g, '')
    .trim();
}
function resolveCity(cfg) {
  const raw = (cfg.city || '').trim();
  if (!raw) return { name: '', code: '100010000', found: false };
  const cityMap = typeof CITY_MAP !== 'undefined' ? CITY_MAP : {};
  const parts = raw.split(/[\/、,，;；|\s]+/).map(normalizeCityName).filter(Boolean);
  const candidates = parts.concat([normalizeCityName(raw)]);

  for (const name of candidates) {
    if (cityMap[name]) return { name: name, code: cityMap[name], found: true };
  }
  for (const name in cityMap) {
    if (name !== '全国' && raw.indexOf(name) !== -1) {
      return { name: name, code: cityMap[name], found: true };
    }
  }

  const fallbackName = candidates[0] || raw;
  return { name: fallbackName, code: cityMap['全国'] || '100010000', found: fallbackName === '全国' };
}
function buildSearchUrl(cfg) {
  const c = resolveCity(cfg);
  const params = new URLSearchParams({ query: cfg.keyword || '', city: c.code });
  if (cfg.jobType) params.set('jobType', cfg.jobType);
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
}
async function ensureTab(url) {
  // 优先找已有的BOSS直聘标签页
  let tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  let tab = tabs[0];
  if (!tab) {
    // 没有已打开的BOSS直聘页，创建新标签
    tab = await chrome.tabs.create({ url: url });
  } else {
    // 复用已有标签，导航到目标URL
    await chrome.tabs.update(tab.id, { url: url, active: true });
  }
  await waitTabComplete(tab.id);
  await sleep(2000);
  return tab;
}
async function getSearchTab(cfg) { return ensureTab(buildSearchUrl(cfg)); }
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false;
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
  state.phase = 'collecting'; pushPhase();
  const cfg = await getCfg();
  if (!cfg.dsKey) { log('请先填写 DeepSeek API Key', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!cfg.keyword) { log('请先填写岗位关键词', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!(cfg.resumeText || '').trim()) { log('请先在设置里填写"简历文字"（AI筛选和招呼语都需要它）', 'error'); state.phase = 'idle'; pushPhase(); return; }

  const _c = resolveCity(cfg);
  log('打开搜索页：' + cfg.keyword + ' | 城市：' + (_c.found ? _c.name : '全国'));
  if (cfg.city && !_c.found) log('城市"' + cfg.city + '"未识别，已按全国搜索', 'warn');
  const tab = await getSearchTab(cfg);
  const count = parseInt(cfg.count) || 20;

  log('收集岗位中（目标 ' + count + ' 个）...');
  await ensureInjected(tab.id, 'src/content-search.js');
  // BOSS直聘：点击求职类型筛选（实习/兼职）
  if (cfg.jobType) {
    const typeMap = { '100020000': '兼职', '100030000': '实习' };
    const typeName = typeMap[cfg.jobType] || '实习';
    log('选择求职类型：' + typeName);
    await sleep(1000);
    const jtResult = await sendToTab(tab.id, { type: 'SET_JOB_TYPE_BOSS', typeName: typeName });
    if (jtResult && jtResult.success) log('求职类型已选择：' + typeName, 'success');
    else log('求职类型选择失败，使用URL参数兜底：' + ((jtResult && jtResult.error) || ''), 'warn');
  }
  const r = await sendToTab(tab.id, { type: 'SCRAPE', count: count });
  if (!r || !r.success) { log('收集失败：' + (r && r.error), 'error'); state.phase = 'idle'; pushPhase(); return; }
  state.jobs = r.jobs || [];
  log('收集到 ' + state.jobs.length + ' 个岗位', 'success');
  if (!state.jobs.length) { state.phase = 'idle'; pushPhase(); return; }

  const ruleResult = applyRuleFilter(cfg, state.jobs);
  state.screened = ruleResult.filtered.slice();
  if (ruleResult.filtered.length) {
    log('规则过滤 ' + ruleResult.filtered.length + ' 个岗位，剩余 ' + ruleResult.passed.length + ' 个进入 AI 筛选', 'warn');
  }
  if (!ruleResult.passed.length) {
    state.phase = 'review'; pushPhase();
    await chrome.storage.local.set({ sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened });
    chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
    log('没有岗位需要 AI 筛选，已进入审核确认', 'success');
    return;
  }

  // 筛选（并发3）
  state.phase = 'screening'; pushPhase();
  log('AI 筛选中（DeepSeek）...');
  let done = 0; const total = ruleResult.passed.length;
  progress(0, total, '筛选');
  const CONC = 3;
  for (let i = 0; i < ruleResult.passed.length; i += CONC) {
    if (state.aborted) break; await waitIfPaused();
    const batch = ruleResult.passed.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      let res;
      try { res = await screenJob(cfg, job); }
      catch (e) { res = { match: false, reason: '筛选异常:' + e.message }; }
      state.screened.push(Object.assign({}, job, { match: res.match, reason: res.reason }));
      done++; progress(done, total, '筛选');
    }));
  }
  const screenedById = {};
  state.screened.forEach(j => { screenedById[j.id] = j; });
  state.screened = state.jobs.map(j => screenedById[j.id] || Object.assign({}, j, { match: false, reason: '未完成筛选' }));
  const matched = state.screened.filter(j => j.match).length;
  log('筛选完成：匹配 ' + matched + ' / ' + state.jobs.length, 'success');
  // 存盘：SW 可能在审核期间被浏览器回收，投递时需从存储读回
  await chrome.storage.local.set({ sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened });
  state.phase = 'review'; pushPhase();
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}

// ── 流程：投递（单个闭环：建联→进聊天页→发图片+招呼语→回搜索页→下一个）──
async function runDeliver(jobIds) {
  state.aborted = false; state.paused = false; state.results = [];
  state.phase = 'delivering'; pushPhase();
  // SW 可能在审核期间被回收，内存丢了就从存储读回
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  const cfg = await getCfg();
  if (!cfg.resumeImage) log('未上传简历图片，将只发招呼语', 'warn');

  const ids = (jobIds || []).filter(id => !state.processed[id]);
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }

  // 找到搜索页标签（不导航它，保持原样）
  let searchTab = null;
  const allTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  for (const t of allTabs) {
    const u = t.url || '';
    if (u.indexOf('/web/geek/jobs') >= 0 || u.indexOf('/web/geek/job?') >= 0) { searchTab = t; break; }
  }
  if (!searchTab) { log('未找到BOSS直聘搜索页标签', 'error'); finishDeliver(); return; }
  log('搜索页标签已锁定（ID:' + searchTab.id + '），投递期间不会刷新它');

  for (let k = 0; k < ids.length; k++) {
    if (state.aborted) break; await waitIfPaused();
    const job = findJob(ids[k]);
    if (!job) { log('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); continue; }
    if (!job.link) { recordFail(job, '没有岗位链接'); log('[' + (k + 1) + '/' + ids.length + '] 没有岗位链接，跳过', 'warn'); progress(k + 1, ids.length, '投递'); continue; }
    log('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));

    // 1. 新标签页打开岗位详情页（搜索页不动）
    log('  新标签打开岗位页...');
    const detailTab = await chrome.tabs.create({ url: job.link, active: true });
    await waitTabComplete(detailTab.id);
    await ensureInjected(detailTab.id, 'src/content-search.js');

    // 2. 同时：读JD + 点立即沟通（并行）
    log('  读取JD并点击立即沟通...');
    const [jdr] = await Promise.all([
      sendToTab(detailTab.id, { type: 'OPEN_JD', job: job }),
      sleep(800).then(() => sendToTab(detailTab.id, { type: 'GO_CHAT', job: job }))
    ]);
    const jd = (jdr && jdr.jd) || '';

    // 3. 等待进入聊天页（失败则刷新重试一次）
    let enteredChat = false;
    for (let retry = 0; retry < 2; retry++) {
      if (retry > 0) {
        log('  刷新页面重试...');
        await chrome.tabs.reload(detailTab.id);
        await waitTabComplete(detailTab.id);
        await sleep(1500);
        await ensureInjected(detailTab.id, 'src/content-search.js');
        await sendToTab(detailTab.id, { type: 'GO_CHAT', job: job });
      }
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        const u = await curUrl(detailTab.id);
        if (u.indexOf('/web/geek/chat') >= 0) { enteredChat = true; break; }
      }
      if (enteredChat) break;
      log(retry === 0 ? '  未进入聊天，将刷新重试...' : '  重试后仍未进入聊天', retry === 0 ? 'warn' : 'error');
    }
    if (!enteredChat) {
      recordFail(job, '未跳转聊天页');
      await chrome.tabs.remove(detailTab.id).catch(() => {});
      progress(k + 1, ids.length, '投递');
      continue;
    }

    // 4. 生成招呼语（在聊天页等待时生成，不浪费时间）
    log('  AI生成专属招呼语...');
    let greeting = '';
    try { greeting = await genGreetingFromJD(cfg, job, jd); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (!greeting) { recordFail(job, '招呼语生成失败'); log('  招呼语为空，跳过', 'warn'); await chrome.tabs.remove(detailTab.id).catch(() => {}); progress(k + 1, ids.length, '投递'); continue; }

    // 5. 发送简历 + 招呼语
    await ensureInjected(detailTab.id, 'src/content-chat.js');
    log('  发简历图片 + 招呼语...');
    const r = await sendToTab(detailTab.id, { type: 'SEND_ACTIVE', image: cfg.resumeImage || '', greeting: greeting });
    if (r && r.success) {
      recordOk(job);
      state.processed[job.id] = 1;
      await chrome.storage.local.set({ processed: state.processed });
      log('  ✓ 投递成功', 'success');
    } else {
      recordFail(job, (r && r.error) || '发送失败');
      log('  失败：' + ((r && r.error) || '发送失败'), 'error');
    }

    // 7. 等待图片发送完成，再关闭标签页
    await sleep(1500);
    await chrome.tabs.remove(detailTab.id).catch(() => {});
    await chrome.tabs.update(searchTab.id, { active: true }).catch(() => {});
    progress(k + 1, ids.length, '投递');
    await rand(2500, 4500);
  }
  finishDeliver();
}
function recordOk(job) { state.results.push({ id: job.id, name: job.name, ok: true }); }
function recordFail(job, msg) { state.results.push({ id: job.id, name: job.name, ok: false, msg: msg }); }
function finishDeliver() {
  const ok = state.results.filter(r => r.ok).length;
  const fail = state.results.length - ok;
  state.phase = 'done'; pushPhase();
  log('投递完成：成功 ' + ok + ' | 失败 ' + fail, 'success');
  chrome.runtime.sendMessage({ type: 'DONE', ok: ok, fail: fail }).catch(() => {});
}

// ── 消息入口 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_COLLECT') { runCollect(); sendResponse({ ok: true }); return; }
  if (msg.type === 'START_DELIVER') { runDeliver(msg.jobIds); sendResponse({ ok: true }); return; }
  if (msg.type === 'PAUSE') { state.paused = true; log('已暂停', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESUME') { state.paused = false; log('继续', 'info'); sendResponse({ ok: true }); return; }
  if (msg.type === 'STOP') { state.aborted = true; state.paused = false; log('已停止', 'warn'); state.phase = 'idle'; pushPhase(); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESET') { state.processed = {}; chrome.storage.local.set({ processed: {} }); state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; state.phase = 'idle'; pushPhase(); log('已重置（清空已投记录）', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'GET_STATE') { sendResponse({ phase: state.phase, screened: state.screened }); return; }
});

chrome.storage.local.get('processed').then(r => { if (r.processed) state.processed = r.processed; });
