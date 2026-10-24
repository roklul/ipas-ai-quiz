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
  if (x.wrong > 0) return 0;        // 錯過又沒掌握 → 最該練
  if ((x.attempts || 0) === 0) return 1; // 沒做過
  return 2;                          // 做過但還沒掌握
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
    q.options.forEach((o, i) => lines.push(`- **${'ABCD'[i]}.** ${o}${i === q.answer ? '  **(正解 ✓)**' : ''}`));
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary><b>▶ 點擊查看答案、考生回答與 AI 逐項解析（正解：${'ABCD'[q.answer]}）</b></summary>`);
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

  if (p && (p.studentAnswer || p.note)) {
    toggleChildren.push({
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: `【考生回答 / 解題思路】\n${(p.studentAnswer || p.note || '').slice(0, 1900)}`,
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

  if (p && p.note && p.studentAnswer) {
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
            text: { content: `▶️ 點擊查看答案、考生回答與 AI 檢查解析（正解：${'ABCD'[q.answer]}）` },
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

