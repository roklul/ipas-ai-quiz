// 純邏輯,無 DOM、無 localStorage,方便用 node 測。app.js 與 core.test.mjs 都 import 這裡。

export const MASTER_BOX = 3; // box 從 1 起,到 3 視為「已掌握」= 連續答對 2 次

// 答對往前一格、答錯退回第一格,推到第三格就算掌握(紙卡背單字的老做法)。
export function nextBox(box, correct) {
  const b = box || 1;
  return correct ? Math.min(b + 1, MASTER_BOX) : 1;
}

// 出題優先序(數字小先練):答錯未掌握 > 沒做過 > 做過未掌握 > 已掌握。供「智慧複習」排序。
export function reviewPriority(p) {
  const x = p || { box: 1, attempts: 0, wrong: 0 };
  if (isMastered(x.box)) return 3;
  if ((x.attempts || 0) === 0) return 1; // 沒做過的新題
  if (x.box === 1 && x.wrong > 0) return 0; // 當前錯題 (box 1)
  return 2; // box 2 (做過且已答對 1 次，進入鞏固期)
}

export function isMastered(box) {
  return (box || 1) >= MASTER_BOX;
}

// 模擬考計分。questions 為出題順序,answers[i] 為該題選的選項 index(null=未作答)。
export function scoreExam(questions, answers) {
  let correct = 0;
  const wrongIds = [];
  questions.forEach((q, i) => {
    if (answers[i] === q.answer) correct++;
    else wrongIds.push(q.id);
  });
  const total = questions.length;
  return {
    total,
    correct,
    wrong: total - correct,
    percent: total ? Math.round((correct / total) * 1000) / 10 : 0,
    wrongIds,
  };
}

// 依科目彙整正確率與掌握度。progress 為 { [id]: {box, attempts, correct, wrong} }。
export function progressStats(questions, progress) {
  const bySubject = {};
  let practiced = 0, mastered = 0, wrongNow = 0;
  for (const q of questions) {
    const p = progress[q.id] || { box: 1, attempts: 0, correct: 0, wrong: 0 };
    const s = (bySubject[q.subject] ||= { subject: q.subject, total: 0, attempts: 0, correct: 0, mastered: 0 });
    s.total++;
    s.attempts += p.attempts;
    s.correct += p.correct;
    if (isMastered(p.box)) s.mastered++;
    if (p.attempts > 0) practiced++;
    if (isMastered(p.box)) mastered++;
    else if (p.wrong > 0) wrongNow++;
  }
  const subjects = Object.values(bySubject).map((s) => ({
    ...s,
    accuracy: s.attempts ? Math.round((s.correct / s.attempts) * 1000) / 10 : null,
  }));
  return { total: questions.length, practiced, mastered, wrongNow, subjects };
}

// 目前的錯題清單(答錯過、尚未掌握),供「只練錯題 / 錯題本」用。
export function wrongQuestionIds(questions, progress) {
  return questions
    .filter((q) => {
      const p = progress[q.id];
      return p && p.wrong > 0 && !isMastered(p.box);
    })
    .map((q) => q.id);
}

// 把「有星標或有筆記」的題 + 解析 + 筆記整理成 markdown,供匯出。
export function toMarkdown(questions, progress, title = 'iPAS 筆記') {
  const lines = [`# ${title}`, ''];
  let n = 0;
  for (const q of questions) {
    const p = progress[q.id];
    if (!p || (!p.starred && !p.note)) continue;
    n++;
    lines.push(`## ${n}. [${q.subject}] ${q.question}`);
    if (q.image) lines.push('- (此題含附圖,請對照站上題目)');
    q.options.forEach((o, i) => lines.push(`- ${'ABCD'[i]}. ${o}${i === q.answer ? ' ✓（正解）' : ''}`));
    if (q.explanation) lines.push(`- 解析：${q.explanation}`);
    if (p.note) lines.push(`- 我的筆記：${p.note}`);
    lines.push('');
  }
  if (n === 0) lines.push('_(還沒有星標或筆記的題目)_');
  return lines.join('\n');
}

// 整理成 Notion Toggle Active Recall 遮答格式（含 題目｜答案｜考生回答｜AI 檢查標準格式）
export function toNotionMarkdown(questions, progress, title = 'iPAS 關鍵字與複習筆記') {
  const lines = [`# ${title}`, ''];
  let n = 0;
  for (const q of questions) {
    const p = (progress && progress[q.id]) || {};
    if (!p.starred && !p.note && !p.studentAnswer && (p.wrong || 0) === 0) continue;
    n++;
    const kw = q.topic || q.chapter || q.subject;
    lines.push(`### ${n}. 【${q.level}・${kw}】${q.question}`);
    lines.push('');
    q.options.forEach((o, i) => lines.push(`- **${'ABCD'[i]}.** ${o}`));
    lines.push('');
    lines.push('<details>');
    lines.push('<summary><b>▶ 點擊查看答案、考生回答與 AI 逐項解析</b></summary>');
    lines.push('');
    lines.push(`> **【正確答案】**：${'ABCD'[q.answer]}. ${q.options[q.answer]}`);
    if (p.studentAnswer) {
      lines.push('');
      lines.push('> **【考生回答 / 解題思路】**：');
      p.studentAnswer.split('\n').forEach((l) => lines.push(`> ${l}`));
    }
    if (q.explanation) {
      lines.push('');
      lines.push('> **【AI 檢查考生回答與考點解析】**：');
      q.explanation.split('\n').forEach((l) => lines.push(`> ${l}`));
    }
    if (p.note) {
      lines.push('');
      lines.push(`> **✍️ 我的筆記**：${p.note}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (n === 0) lines.push('_(目前尚無星標、筆記或錯題)_');
  return lines.join('\n');
}

// 建構 Notion Database Page Payload（含 題目｜答案｜考生回答｜AI 檢查標準格式）
export function buildNotionPagePayload(q, p = {}, dbId, dbSchema = null) {
  let titlePropName = 'Name';
  if (dbSchema && dbSchema.properties) {
    for (const [key, val] of Object.entries(dbSchema.properties)) {
      if (val.type === 'title') {
        titlePropName = key;
        break;
      }
    }
  }

  const keyword = q.topic || q.chapter || q.subject;
  const titleText = `[${q.level}・${keyword}] ${q.question.slice(0, 50)}${q.question.length > 50 ? '…' : ''}`;

  const properties = {
    [titlePropName]: {
      title: [{ text: { content: titleText } }],
    },
  };

  if (dbSchema && dbSchema.properties) {
    const props = dbSchema.properties;
    for (const [key, val] of Object.entries(props)) {
      const lower = key.toLowerCase();
      if ((lower.includes('level') || lower.includes('級別')) && val.type === 'select') {
        properties[key] = { select: { name: q.level } };
      } else if ((lower.includes('subject') || lower.includes('科目')) && val.type === 'select') {
        properties[key] = { select: { name: q.subject.replace(/科目\d[：:]\s*/, '') } };
      } else if ((lower.includes('chapter') || lower.includes('章節')) && val.type === 'select') {
        properties[key] = { select: { name: q.chapter || q.subject } };
      } else if ((lower.includes('tag') || lower.includes('標籤') || lower.includes('關鍵字')) && val.type === 'multi_select') {
        const tags = [q.level, q.chapter, q.topic].filter(Boolean);
        properties[key] = { multi_select: tags.map((t) => ({ name: t })) };
      } else if ((lower.includes('status') || lower.includes('掌握') || lower.includes('狀態')) && val.type === 'select') {
        const statusName = isMastered(p.box) ? '已掌握' : (p.wrong > 0 ? '錯題待複習' : '學習中');
        properties[key] = { select: { name: statusName } };
      }
    }
  }

  const optionBlocks = q.options.map((opt, idx) => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [
        {
          type: 'text',
          text: {
            content: `${'ABCD'[idx]}. ${opt}${idx === q.answer ? ' ✓（正解）' : ''}`,
          },
          annotations: idx === q.answer ? { bold: true, color: 'green' } : {},
        },
      ],
    },
  }));

  const toggleChildren = [
    {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '✅' },
        rich_text: [
          {
            type: 'text',
            text: { content: `【正確答案】${'ABCD'[q.answer]}. ${q.options[q.answer]}` },
            annotations: { bold: true, color: 'green' },
          },
        ],
      },
    },
    ...optionBlocks,
  ];

  if (p && p.studentAnswer) {
    toggleChildren.push({
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: `【考生回答 / 解題思路】\n${p.studentAnswer.slice(0, 1900)}`,
            },
          },
        ],
      },
    });
  }

  if (q.explanation) {
    toggleChildren.push({
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '🤖' },
        rich_text: [
          {
            type: 'text',
            text: { content: `【AI 檢查考生回答與考點解析】\n${q.explanation.slice(0, 1900)}` },
          },
        ],
      },
    });
  }

  if (p && p.note) {
    toggleChildren.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: `✍️ 個人筆記：${p.note.slice(0, 1900)}` },
            annotations: { italic: true },
          },
        ],
      },
    });
  }

  const children = [
    {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '💡' },
        rich_text: [
          {
            type: 'text',
            text: {
              content: `考點與關鍵字：${q.topic ? `${q.topic} · ` : ''}${q.chapter || q.subject}（${q.level}）`,
            },
            annotations: { bold: true },
          },
        ],
      },
    },
    {
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: [{ type: 'text', text: { content: '【題目】' } }],
      },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: q.question } }],
      },
    },
    {
      object: 'block',
      type: 'toggle',
      toggle: {
        rich_text: [
          {
            type: 'text',
            text: { content: '▶️ 點擊查看答案、考生回答與 AI 檢查解析' },
            annotations: { bold: true, color: 'blue' },
          },
        ],
        children: toggleChildren,
      },
    },
  ];

  return {
    parent: { database_id: dbId },
    properties,
    children,
  };
}

// 從練習紀錄推「這個人在準備哪一級」。題目 id 內含級別:`-b-`=初級、`-m-`=中級
// (114-4-b-s1-q1 / lg-m-s2-q7)。790 題零例外,所以不必查題庫,看 id 就夠。
// 回傳 null = 資料不足以判斷(沒練過,或兩級練得差不多)。
// 門檻 0.6:實測 400 個活躍使用者有 92% 落在單邊 60% 以上,中間那 5% 混著練的本來就不該猜。
export function guessLevel(progress, minAnswered = 5) {
  let b = 0, m = 0;
  for (const id of Object.keys(progress || {})) {
    if (id.includes('-b-')) b++;
    else if (id.includes('-m-')) m++;
  }
  const n = b + m;
  if (n < minAnswered) return null;
  if (b / n >= 0.6) return '初級';
  if (m / n >= 0.6) return '中級';
  return null;
}

// 從官方日期表挑「還沒到的最近一場」。level 給了就只看那一級,沒給就看全部。
// exams = { '初級': ['2026-11-07', ...], '中級': [...] };todayStr = 'YYYY-MM-DD'
export function nextExam(exams, todayStr, level = null) {
  let best = null;
  for (const [lv, dates] of Object.entries(exams || {})) {
    if (level && lv !== level) continue;
    for (const d of dates || []) {
      if (d < todayStr) continue;
      if (!best || d < best.date) best = { level: lv, date: d };
    }
  }
  return best;
}

// 考點心智卡轉換為 Notion Markdown 格式
export function cardToNotionMarkdown(card) {
  return [
    `# 📌 [考點心智卡] ${card.title}`,
    `> **類別**：${card.category}`,
    `> **核心概念**：${card.subtitle || ''}`,
    '',
    `### 🔹 核心功能`,
    card.function,
    '',
    `### 🔸 考題情境`,
    card.scenario,
    '',
    `### ⚠️ 陷阱提醒`,
    card.trap,
    '',
    '<details>',
    `<summary>▶️ 關鍵字清單</summary>`,
    '',
    (card.keywords || []).map((k) => `- ${k}`).join('\n'),
    '',
    '</details>',
  ].join('\n');
}

// 艾賓浩斯遺忘曲線間隔（天數）：1天、3天、7天、14天、30天
export const EBBINGHAUS_INTERVALS_DAYS = [1, 3, 7, 14, 30];

// 計算下一次複習排程（艾賓浩斯間隔重複）
export function calcNextReview(currentStage = 0, isCorrect = true, now = Date.now()) {
  let nextStage;
  if (!isCorrect) {
    nextStage = 1; // 答錯或複習未過，退回第一階段
  } else {
    nextStage = Math.min((currentStage || 0) + 1, EBBINGHAUS_INTERVALS_DAYS.length);
  }
  const days = EBBINGHAUS_INTERVALS_DAYS[nextStage - 1];
  const due = now + days * 86400000;
  return {
    stage: nextStage,
    days,
    due,
    mastered: isCorrect && nextStage >= EBBINGHAUS_INTERVALS_DAYS.length,
  };
}

// 格式化複習到期狀態
export function formatReviewDue(dueTimestamp, now = Date.now()) {
  if (!dueTimestamp) return null;
  const diff = dueTimestamp - now;
  if (diff <= 0) return { isDue: true, label: '今日到期待複習', daysRemaining: 0 };
  const hours = Math.ceil(diff / 3600000);
  if (hours < 24) return { isDue: false, label: `${hours} 小時後複習`, daysRemaining: 1 };
  const days = Math.ceil(diff / 86400000);
  return { isDue: false, label: `${days} 天後複習`, daysRemaining: days };
}

// 解析詳解中的各選項解析字串
export function parseExplanationOptions(explanation = '') {
  const map = {};
  if (!explanation) return map;
  const regex = /(?:^|\s|[。；;])(?:\(([A-D])\)|（([A-D])）|【([A-D])】|([A-D])[\.、:：])/g;
  let m;
  const indices = [];
  while ((m = regex.exec(explanation)) !== null) {
    const letter = m[1] || m[2] || m[3] || m[4];
    indices.push({ letter, start: m.index + m[0].length, index: m.index });
  }
  for (let i = 0; i < indices.length; i++) {
    const nextStart = indices[i + 1] ? indices[i + 1].index : explanation.length;
    const raw = explanation.slice(indices[i].start, nextStart).trim();
    map[indices[i].letter] = raw.replace(/^[。；;、:\s]+|[。；;、\s]+$/g, '');
  }
  return map;
}

// AI 檢查考生回答：比對選項、解析思維盲點與各選項干擾因
export function diagnoseStudentAnswer(q, pickedIdx = null, studentAnswerText = '') {
  const correctLetter = 'ABCD'[q.answer];
  const pickedLetter = pickedIdx !== null && pickedIdx !== undefined && pickedIdx >= 0 ? 'ABCD'[pickedIdx] : null;
  const isCorrect = pickedIdx === q.answer;
  const optMap = parseExplanationOptions(q.explanation || '');

  // 1. 各選項逐項解說
  const optionBreakdowns = q.options.map((opt, idx) => {
    const letter = 'ABCD'[idx];
    const isAns = idx === q.answer;
    const isPicked = idx === pickedIdx;
    const expText = optMap[letter] || (isAns ? '官方正解核心概念。' : '干擾選項。');
    return {
      letter,
      text: opt,
      isCorrect: isAns,
      isPicked,
      analysis: expText,
    };
  });

  // 2. 考生思路比對與考點關鍵詞提取（防範空解析或短文字 match 為 null）
  const trimmedAnswer = (studentAnswerText || '').trim();
  const matchedKeywords = [];
  const missingKeywords = [];

  const explanationText = q.explanation || '';
  const expMatches = explanationText.match(/[一-龥A-Za-z0-9_-]{3,12}/g) || [];
  const candidateKeywords = [
    q.topic,
    q.chapter,
    ...expMatches,
  ].filter(Boolean);
  const uniqueKeyTerms = Array.from(new Set(candidateKeywords)).filter((kw) => kw.length >= 3).slice(0, 8);

  if (trimmedAnswer) {
    for (const kw of uniqueKeyTerms) {
      if (trimmedAnswer.toLowerCase().includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
      } else if (matchedKeywords.length < 3) {
        missingKeywords.push(kw);
      }
    }
  }

  // 3. 語意反向陷阱檢測（否定詞/限制詞）
  const hasNegation = /(?:不需|不需要|不用|不是|並非|缺乏|相反|沒有|未提供|不具備|非)/.test(trimmedAnswer);

  // 4. 診斷摘要與建議（客觀陳述比對結果，不宣稱考生已完全理解）
  let statusSummary = '';
  let advice = '';

  if (pickedLetter === null) {
    statusSummary = '尚未作答';
    advice = '建議先選出答案，並在下方簡要寫下你的推論依據與其他選項的破綻。';
  } else if (isCorrect) {
    statusSummary = `選擇正解（${correctLetter}）`;
    if (!trimmedAnswer) {
      advice = `作答正確！建議在下方寫下你選擇 (${correctLetter}) 的理由或排除了哪些干擾項，以主動回想鞏固記憶。`;
    } else if (hasNegation) {
      advice = `選擇正確，且自述中提及考點詞「${matchedKeywords.slice(0, 3).join('、') || '相關概念'}」。⚠️ 注意：自述包含否定或限制詞彙，請務必比對下方官方詳解，確認是否符合正解之因果定義，避免反向誤解。`;
    } else if (matchedKeywords.length > 0) {
      advice = `選擇正確，自述提及相關考點詞「${matchedKeywords.slice(0, 3).join('、')}」。請對照下方【各選項解析與干擾陷阱剖析】，核對推論因果是否完全相符（提及名詞不代表因果完全正確，建議自主審視論證）。`;
    } else {
      advice = '選擇正確！但自述中未出現官方核心考點名詞。建議對照下方詳解補齊關鍵論證。';
    }
  } else {
    statusSummary = `選擇非正解（選 ${pickedLetter}，正解為 ${correctLetter}）`;
    const pickedOptAnalysis = optMap[pickedLetter] ? `選項 (${pickedLetter}) 陷阱剖析：${optMap[pickedLetter]}` : `選項 (${pickedLetter}) 為干擾項。`;
    if (!trimmedAnswer) {
      advice = `${pickedOptAnalysis} 請思考為何 (${correctLetter}) 才是正確答案。`;
    } else {
      advice = `你選擇了 (${pickedLetter})。${pickedOptAnalysis} 即使自述提及「${matchedKeywords.slice(0, 3).join('、') || '相關概念'}」，仍須特別留意概念條件是否與正解 (${correctLetter}) 相悖。請詳讀下方各選項剖析。`;
    }
  }

  return {
    isCorrect,
    correctLetter,
    pickedLetter,
    statusSummary,
    advice,
    hasNegation,
    matchedKeywords,
    missingKeywords: missingKeywords.slice(0, 3),
    optionBreakdowns,
    explanation: explanationText,
  };
}

// 確保舊版歷史統計平滑過渡 (P1)：若已有舊版作答次數且尚無 logs，將既有作答數遷移為基準 event logs
export function ensureQuestionLogs(p, qid) {
  if (!p) return;
  p.logs ||= [];
  if (p.logs.length === 0 && (p.attempts || 0) > 0) {
    const baseTime = p.lastAnsweredAt || p.updatedAt || 1000;
    const cCount = p.correct || 0;
    const wCount = p.wrong || 0;
    const total = p.attempts || (cCount + wCount);
    for (let i = 0; i < cCount; i++) {
      p.logs.push({ id: `legacy_${qid}_c_${i}`, t: baseTime, c: true });
    }
    for (let i = 0; i < wCount; i++) {
      p.logs.push({ id: `legacy_${qid}_w_${i}`, t: baseTime, c: false });
    }
    for (let i = p.logs.length; i < total; i++) {
      p.logs.push({ id: `legacy_${qid}_u_${i}`, t: baseTime, c: false });
    }
  }
}

// 辨識系統自動產生之區塊（舊版頁面沒有 notionBlockIds 時的保守判斷）(FR-07, AC-09)
// 只認系統寫入的固定標記；寧可漏刪（重複內容）也不可誤刪考生自己在頁面內新增的內容。
export function isSystemManagedBlock(b, q = {}) {
  if (!b || !b.type) return false;
  const content = (b[b.type]?.rich_text || [])
    .map((t) => t.plain_text || t.text?.content || '')
    .join('')
    .trim();

  if (b.type === 'callout') {
    if (b.callout?.icon?.emoji === '💡' && content.startsWith('考點與關鍵字')) return true;
  }
  if (b.type === 'heading_3') {
    if (content === '【題目】') return true;
  }
  if (b.type === 'toggle') {
    if (content.startsWith('▶️ 點擊查看答案、考生回答與 AI 檢查解析')) return true;
  }
  if (b.type === 'paragraph') {
    if (q.question && content === q.question.trim()) return true;
  }
  return false;
}

// 智慧深度合併兩份進度（唯一作答事件去重 + 自洽統計快照 + 獨立屬性時間戳 + 重設版本隔離）
export function mergeStores(target, incoming, todayStr = new Date().toISOString().slice(0, 10)) {
  if (!incoming || !incoming.q) return target;
  const out = structuredClone(target);
  out.q ||= {};
  out.cards ||= {};
  out.history ||= {};
  out.settings = { ...(incoming.settings || {}), ...(out.settings || {}) };
  const stripSecrets = () => { if (out.settings) { delete out.settings.notionToken; delete out.settings.notionDbId; delete out.settings.notionProxy; } };
  stripSecrets();

  // 重設版本隔離 (AC-08): 取兩端較新之重設時間戳
  const resetAt = Math.max(target.statsResetAt || 0, incoming.statsResetAt || 0);
  if (resetAt > 0) out.statsResetAt = resetAt;

  if ((incoming.updatedAt || 0) > (out.updatedAt || 0)) {
    out.settings = { ...(out.settings || {}), ...(incoming.settings || {}) };
    if (incoming.syncCode) out.syncCode = incoming.syncCode;
    stripSecrets();
  }

  // 1. 合併每題進度 q：同時遍歷 target 與 incoming 之所有題目 (兩端全集)，杜絕遠端重設刪除之題目被復活
  const allQids = new Set([...Object.keys(target.q || {}), ...Object.keys(incoming.q || {})]);
  out.q = {};

  for (const qid of allQids) {
    const rawTp = target.q ? target.q[qid] : null;
    const rawIp = incoming.q ? incoming.q[qid] : null;

    let tp = rawTp ? structuredClone(rawTp) : null;
    let ip = rawIp ? structuredClone(rawIp) : null;

    // 若有重設時間戳，對早於重設點之歷史紀錄進行過濾隔離
    if (resetAt > 0) {
      if (tp) {
        tp.logs = (tp.logs || []).filter((l) => l && l.id && (l.t || 0) > resetAt);
        if ((tp.lastAnsweredAt || tp.updatedAt || 0) <= resetAt && (!tp.logs || !tp.logs.length)) {
          tp.attempts = 0;
          tp.correct = 0;
          tp.wrong = 0;
          tp.lastAnsweredAt = 0;
          tp.box = 1;
        }
      }
      if (ip) {
        ip.logs = (ip.logs || []).filter((l) => l && l.id && (l.t || 0) > resetAt);
        if ((ip.lastAnsweredAt || ip.updatedAt || 0) <= resetAt && (!ip.logs || !ip.logs.length)) {
          ip.attempts = 0;
          ip.correct = 0;
          ip.wrong = 0;
          ip.lastAnsweredAt = 0;
          ip.box = 1;
        }
      }

      // 檢查此題目在重設後是否具備保留意義（有筆記、思路、星標或重設後新作答）
      const hasNote = (tp && tp.note) || (ip && ip.note);
      const hasStudentAnswer = (tp && tp.studentAnswer) || (ip && ip.studentAnswer);
      const hasStarred = (tp && tp.starred) || (ip && ip.starred);
      const hasPostResetLogs = (tp && tp.logs && tp.logs.length > 0) || (ip && ip.logs && ip.logs.length > 0);
      const hasPostResetAns = (tp && tp.lastAnsweredAt > resetAt) || (ip && ip.lastAnsweredAt > resetAt);

      if (!hasNote && !hasStudentAnswer && !hasStarred && !hasPostResetLogs && !hasPostResetAns) {
        // 此題在重設時已刪除，且無保留內容或新作答，嚴禁復活！
        continue;
      }
    }

    // 若無 reset 影響但有舊版作答，確保平滑遷移 logs
    if (tp && tp.attempts > 0 && (!tp.logs || !tp.logs.length)) ensureQuestionLogs(tp, qid);
    if (ip && ip.attempts > 0 && (!ip.logs || !ip.logs.length)) ensureQuestionLogs(ip, qid);

    if (!tp) {
      out.q[qid] = ip;
      continue;
    }
    if (!ip) {
      out.q[qid] = tp;
      continue;
    }

    // A. 作答事件唯一 ID 合併與去重 (AC-07): 兩端各答一次均保留，反覆同步數字不變
    let finalAttempts = 0;
    let finalCorrect = 0;
    let finalWrong = 0;
    let finalLastAnsweredAt = 0;
    let mergedLogs = [];

    const hasLogs = (tp.logs && tp.logs.length) || (ip.logs && ip.logs.length);
    if (hasLogs) {
      const logMap = new Map();
      for (const l of (tp.logs || [])) {
        if (l && l.id && (l.t || 0) > resetAt) logMap.set(l.id, l);
      }
      for (const l of (ip.logs || [])) {
        if (l && l.id && (l.t || 0) > resetAt) logMap.set(l.id, l);
      }
      mergedLogs = Array.from(logMap.values()).sort((a, b) => a.t - b.t);
      finalAttempts = mergedLogs.length;
      finalCorrect = mergedLogs.filter((l) => l.c).length;
      finalWrong = mergedLogs.filter((l) => !l.c).length;
      finalLastAnsweredAt = mergedLogs.length ? mergedLogs[mergedLogs.length - 1].t : 0;
    } else {
      // 兼容無 logs 之舊版資料：採自洽統計快照，絕不跨端各取 max
      let stats;
      const tAttempts = tp.attempts || 0;
      const iAttempts = ip.attempts || 0;
      if (iAttempts > tAttempts) stats = ip;
      else if (tAttempts > iAttempts) stats = tp;
      else {
        const tAnsTime = tp.lastAnsweredAt || tp.updatedAt || 0;
        const iAnsTime = ip.lastAnsweredAt || ip.updatedAt || 0;
        stats = (iAnsTime >= tAnsTime) ? ip : tp;
      }
      const statsValid = (stats.lastAnsweredAt || stats.updatedAt || 0) > resetAt;
      finalAttempts = statsValid ? (stats.attempts || 0) : 0;
      finalCorrect = statsValid ? (stats.correct || 0) : 0;
      finalWrong = statsValid ? (stats.wrong || 0) : 0;
      finalLastAnsweredAt = statsValid ? (stats.lastAnsweredAt || 0) : 0;
    }

    // 箱位決定：有事件紀錄就重播（與次數自洽）；含舊版遷移紀錄時無法重播，退回以較新作答端為準
    const tAnsTime = tp.lastAnsweredAt || tp.updatedAt || 0;
    const iAnsTime = ip.lastAnsweredAt || ip.updatedAt || 0;
    const boxWinner = (iAnsTime >= tAnsTime) ? ip : tp;
    const hasLegacyLog = mergedLogs.some((l) => String(l.id).startsWith('legacy_'));
    const finalBox = (mergedLogs.length && !hasLegacyLog)
      ? mergedLogs.reduce((bx, l) => nextBox(bx, l.c), 1)
      : (boxWinner.box || 1);

    // 各欄位只比自己的時間戳；缺時間戳的舊資料僅在該欄有內容時才用 updatedAt 當後備，
    // 否則「單純作答而更新 updatedAt」會蓋掉另一端真正的筆記／星標／排程
    const fieldTime = (x, key, hasValue) => x[key] || (hasValue ? (x.updatedAt || 0) : 0);

    // B. 筆記與解題思路：依 noteUpdatedAt 較新者為準，允許清空刪除
    const tNoteTime = fieldTime(tp, 'noteUpdatedAt', tp.note || tp.studentAnswer);
    const iNoteTime = fieldTime(ip, 'noteUpdatedAt', ip.note || ip.studentAnswer);
    const noteWinner = (iNoteTime > tNoteTime) ? ip : tp;

    // C. 星標標記：依 starredUpdatedAt 較新者為準，允許取消星標
    const tStarTime = fieldTime(tp, 'starredUpdatedAt', tp.starred);
    const iStarTime = fieldTime(ip, 'starredUpdatedAt', ip.starred);
    const starWinner = (iStarTime > tStarTime) ? ip : tp;

    // D. 遺忘曲線排程：依 reviewUpdatedAt 較新者為準（取消排程也有時間戳，不會被舊資料恢復）
    const tRevTime = fieldTime(tp, 'reviewUpdatedAt', tp.reviewDue);
    const iRevTime = fieldTime(ip, 'reviewUpdatedAt', ip.reviewDue);
    const revWinner = (iRevTime > tRevTime) ? ip : tp;

    // E. Notion 頁面關聯與管理區塊 ID
    const notionDbId = revWinner.notionDbId || ip.notionDbId || tp.notionDbId;
    const notionPageId = revWinner.notionPageId || ip.notionPageId || tp.notionPageId;
    const notionBlockIds = revWinner.notionBlockIds || ip.notionBlockIds || tp.notionBlockIds || [];
    const notionSyncedAt = Math.max(tp.notionSyncedAt || 0, ip.notionSyncedAt || 0);

    out.q[qid] = {
      box: finalBox,
      attempts: finalAttempts,
      correct: finalCorrect,
      wrong: finalWrong,
      logs: mergedLogs,
      lastAnsweredAt: finalLastAnsweredAt,
      note: noteWinner.note || '',
      studentAnswer: noteWinner.studentAnswer || '',
      noteUpdatedAt: Math.max(tNoteTime, iNoteTime),
      starred: !!starWinner.starred,
      starredUpdatedAt: Math.max(tStarTime, iStarTime),
      reviewStage: revWinner.reviewStage,
      reviewDue: revWinner.reviewDue,
      reviewUpdatedAt: Math.max(tRevTime, iRevTime),
      notionDbId,
      notionPageId,
      notionBlockIds,
      notionSyncedAt,
      updatedAt: Math.max(tp.updatedAt || 0, ip.updatedAt || 0),
    };
  }

  // 2. 合併心智卡排程 cards
  for (const [cid, ic] of Object.entries(incoming.cards || {})) {
    out.cards[cid] = { ...(ic || {}), ...(out.cards[cid] || {}) };
  }

  // 3. 合併每日歷史 history (套用重設隔離，舊統計不復活)
  if (resetAt > 0) {
    if ((incoming.statsResetAt || 0) === resetAt && (target.statsResetAt || 0) < resetAt) {
      out.history = { ...(incoming.history || {}) };
    } else if ((target.statsResetAt || 0) === resetAt && (incoming.statsResetAt || 0) < resetAt) {
      out.history = { ...(target.history || {}) };
    } else {
      // 兩端同版本重設
      for (const [d, ih] of Object.entries(incoming.history || {})) {
        const th = out.history[d];
        if (!th) {
          out.history[d] = { a: ih.a || 0, c: ih.c || 0 };
        } else {
          out.history[d] = {
            a: Math.max(th.a || 0, ih.a || 0),
            c: Math.max(th.c || 0, ih.c || 0),
          };
        }
      }
    }
  } else {
    for (const [d, ih] of Object.entries(incoming.history || {})) {
      const th = out.history[d];
      if (!th) {
        out.history[d] = { a: ih.a || 0, c: ih.c || 0 };
      } else {
        out.history[d] = {
          a: Math.max(th.a || 0, ih.a || 0),
          c: Math.max(th.c || 0, ih.c || 0),
        };
      }
    }
  }

  // 3b. 由合併後的作答事件重算每日歷史與近期紀錄，確保與 attempts 同源（AC-07：兩端同日各答一次 = 2）
  let derivedRecent = false;
  {
    const ymdLocal = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const allLogs = [];
    const perDay = {};
    for (const p of Object.values(out.q)) {
      for (const l of (p.logs || [])) {
        if (String(l.id).startsWith('legacy_')) continue; // 遷移用基準紀錄沒有真實日期，不納入日統計
        allLogs.push(l);
        const d = (perDay[ymdLocal(l.t)] ||= { a: 0, c: 0 });
        d.a++; if (l.c) d.c++;
      }
    }
    for (const [d, v] of Object.entries(perDay)) {
      const cur = out.history[d];
      out.history[d] = cur ? { a: Math.max(cur.a || 0, v.a), c: Math.max(cur.c || 0, v.c) } : v;
    }
    allLogs.sort((x, y) => x.t - y.t);
    if (allLogs.length) { out.recent = allLogs.slice(-50).map((l) => (l.c ? 1 : 0)); derivedRecent = true; }
  }

  // 4. 今日題數 store.daily 與 history[todayStr] 同步
  const t = todayStr;
  const todayHistA = (out.history[t] && out.history[t].a) || 0;
  const targetDailyCount = (out.daily && out.daily.date === t) ? out.daily.count : 0;
  const incomingDailyCount = (incoming.daily && incoming.daily.date === t) ? incoming.daily.count : 0;
  const maxTodayCount = Math.max(todayHistA, targetDailyCount, incomingDailyCount);
  if (maxTodayCount > 0) {
    out.daily = { date: t, count: maxTodayCount };
    out.history[t] ||= { a: maxTodayCount, c: 0 };
    if (out.history[t].a < maxTodayCount) out.history[t].a = maxTodayCount;
  } else if (resetAt > 0) {
    out.daily = null;
  }

  // 5. 連續打卡天數 streak (若其中一端在 resetAt 後尚未練習，不復活舊 streak)
  if (resetAt > 0) {
    if ((incoming.statsResetAt || 0) === resetAt && (target.statsResetAt || 0) < resetAt) {
      out.streak = incoming.streak || { count: 0, lastDate: '' };
    } else if ((target.statsResetAt || 0) === resetAt && (incoming.statsResetAt || 0) < resetAt) {
      out.streak = target.streak || { count: 0, lastDate: '' };
    } else {
      const ts = out.streak || { count: 0, lastDate: '' };
      const is = incoming.streak || { count: 0, lastDate: '' };
      if ((is.lastDate || '') > (ts.lastDate || '') || ((is.lastDate === ts.lastDate) && (is.count || 0) > (ts.count || 0))) {
        out.streak = { ...is };
      }
    }
  } else {
    const ts = out.streak || { count: 0, lastDate: '' };
    const is = incoming.streak || { count: 0, lastDate: '' };
    if ((is.lastDate || '') > (ts.lastDate || '') || ((is.lastDate === ts.lastDate) && (is.count || 0) > (ts.count || 0))) {
      out.streak = { ...is };
    }
  }

  // 6. 近期作答紀錄 recent (過濾 resetAt 以前之紀錄)
  if (!derivedRecent) {
    // 無事件紀錄可重算（純舊版資料）：沿用現有清單；有重設時無時間戳的舊項目不可復活
    let candidateRecent = (out.recent && out.recent.length) ? out.recent : (incoming.recent || []);
    if (resetAt > 0) candidateRecent = candidateRecent.filter((r) => r && typeof r === 'object' && ((r.t || r.timestamp || 0) > resetAt));
    out.recent = candidateRecent.slice(-50);
  }

  out.updatedAt = Math.max(out.updatedAt || 0, incoming.updatedAt || 0);
  return out;
}

// 具備錯誤隔離、內容保護、分頁處理、重試防重複與資料庫隔離的 Notion 同步函式 (FR-07, AC-09, AC-10)
export async function syncQuestionToNotion(q, p = {}, { dbId, callNotion, fetchDbSchema = null }) {
  if (!dbId) throw new Error('尚未設定 Database ID');
  const schema = fetchDbSchema ? await fetchDbSchema(dbId).catch(() => null) : null;
  const payload = buildNotionPagePayload(q, p, dbId, schema);

  // 依資料庫隔離 (AC-09): 若題目曾同步至其他資料庫，更換資料庫時不可覆寫原資料庫頁面
  const prevMapping = { notionPageId: p.notionPageId, notionBlockIds: p.notionBlockIds, notionDbId: p.notionDbId };
  if (p.notionPageId && p.notionDbId && p.notionDbId !== dbId) {
    delete p.notionPageId;
    delete p.notionBlockIds;
  }

  if (p.notionPageId) {
    let pageUpdated = false;
    // 1. 頁面層級屬性更新 (PATCH /pages/:id)
    try {
      await callNotion(`pages/${p.notionPageId}`, {
        method: 'PATCH',
        body: { properties: payload.properties },
      });
      pageUpdated = true;
      p.notionDbId = dbId;
    } catch (pageErr) {
      // 僅在頁面本身明確 404 (object_not_found) 時，重設 ID 降級為重新建立頁面
      const isNotFound = pageErr.status === 404 || pageErr.code === 'object_not_found' || /not_found/i.test(pageErr.message || '');
      if (isNotFound) {
        // Notion 對「已刪除」與「未分享給 Integration」都回 object_not_found：
        // 先確認資料庫仍可存取，才當作頁面已刪除重建；否則視為授權／分享問題，不新增重複頁面。
        try {
          await callNotion(`databases/${dbId}`);
        } catch (dbErr) {
          if (dbErr.status === 404 || dbErr.code === 'object_not_found') {
            const e = new Error('找不到此頁面與資料庫：請確認 Integration 已被分享到該資料庫（Connections），或 Database ID 是否正確。');
            e.status = 404; e.code = 'access_lost';
            throw e;
          }
          throw dbErr;
        }
        delete p.notionPageId;
        delete p.notionBlockIds;
      } else {
        // 429、500 等暫時性錯誤直接拋出，不清除 notionPageId，不降級為 POST
        throw pageErr;
      }
    }

    if (pageUpdated) {
      // 2. 決定需要管理的系統舊區塊 ID 清單
      let oldManagedBlockIds = [];
      if (Array.isArray(p.notionBlockIds)) {
        oldManagedBlockIds = [...p.notionBlockIds];
      } else {
        // 舊版資料未記錄 notionBlockIds 時：分頁讀取全頁區塊，並保守辨識系統區塊，絕不刪除考生內容 (FR-07)
        let cursor = undefined;
        let allPageBlocks = [];
        do {
          const endpoint = `blocks/${p.notionPageId}/children?page_size=100` + (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '');
          const pageRes = await callNotion(endpoint);
          allPageBlocks.push(...(pageRes?.results || []));
          cursor = pageRes?.has_more ? pageRes.next_cursor : undefined;
        } while (cursor);

        oldManagedBlockIds = allPageBlocks.filter((b) => isSystemManagedBlock(b, q)).map((b) => b.id);
      }

      // 3. 先追加最新內文區塊（確保新內容已成功寫入，絕不預先刪除造成正文清空）
      let newBlockIds = [];
      if (payload.children?.length) {
        const appendRes = await callNotion(`blocks/${p.notionPageId}/children`, {
          method: 'PATCH',
          body: { children: payload.children },
        });
        newBlockIds = (appendRes?.results || []).map((b) => b.id);
        // 合併新舊區塊清單進行持續追蹤；若刪舊失敗，未刪除的舊 ID 絕不遺失，下次重試會繼續清理！
        p.notionBlockIds = [...new Set([...oldManagedBlockIds, ...newBlockIds])];
      }

      // 4. 新內容確認寫入後，逐一刪除舊管理區塊
      for (const oldId of oldManagedBlockIds) {
        try {
          await callNotion(`blocks/${oldId}`, { method: 'DELETE' });
          p.notionBlockIds = (p.notionBlockIds || []).filter((id) => id !== oldId);
        } catch (blockErr) {
          // 區塊 404 代表該區塊已在 Notion 刪除或不存在，視為已刪除
          if (blockErr.status === 404 || blockErr.code === 'object_not_found') {
            p.notionBlockIds = (p.notionBlockIds || []).filter((id) => id !== oldId);
            continue;
          }
          // 刪除失敗時中斷拋出，此時 p.notionBlockIds 仍保留未完成刪除之舊 ID 與新 ID！
          throw blockErr;
        }
      }

      p.notionBlockIds = newBlockIds;
      p.notionDbId = dbId;
      return { id: p.notionPageId, properties: payload.properties };
    }
  }

  // 首次建立頁面
  let result;
  try {
    result = await callNotion('pages', { method: 'POST', body: payload });
  } catch (createErr) {
    Object.assign(p, prevMapping); // 建立失敗：還原原有對應，不遺失舊資料庫的頁面關聯
    for (const k of Object.keys(prevMapping)) if (prevMapping[k] === undefined) delete p[k];
    throw createErr;
  }
  if (result && result.id) {
    p.notionPageId = result.id;
    p.notionDbId = dbId;
    p.notionBlockIds = [];
    if (payload.children?.length) {
      try {
        const blkRes = await callNotion(`blocks/${result.id}/children?page_size=100`);
        p.notionBlockIds = (blkRes?.results || []).map((b) => b.id);
      } catch {
        // 取不到區塊 ID：留空（undefined）而非 []，下次同步會掃描頁面辨識系統區塊，避免永遠不清舊內容而重複追加
        delete p.notionBlockIds;
      }
    }
  }
  return result;
}
