// node core.test.mjs  — 邏輯壞掉就會 throw。
import assert from 'node:assert';
import { nextBox, isMastered, scoreExam, progressStats, wrongQuestionIds, toMarkdown, reviewPriority } from './core.js';

// 出題優先序:錯題(0) < 沒做過(1) < 做過未掌握(2) < 已掌握(3)
assert.equal(reviewPriority({ box: 1, attempts: 2, wrong: 1 }), 0);
assert.equal(reviewPriority({ box: 1, attempts: 0, wrong: 0 }), 1);
assert.equal(reviewPriority({ box: 2, attempts: 1, wrong: 0 }), 2);
assert.equal(reviewPriority({ box: 3, attempts: 3, wrong: 0 }), 3);

// Leitner(MASTER_BOX=3:連對 2 次即掌握)
assert.equal(nextBox(1, true), 2);
assert.equal(nextBox(2, true), 3, '連對 2 次到頂');
assert.equal(nextBox(3, true), 3, '已到頂不超過 3');
assert.equal(nextBox(2, false), 1, '答錯掉回 1');
assert.equal(isMastered(3), true);
assert.equal(isMastered(2), false);

// 計分
const qs = [
  { id: 'a', subject: 'S1', answer: 1, options: ['x', 'y'], question: 'qa' },
  { id: 'b', subject: 'S1', answer: 0, options: ['x', 'y'], question: 'qb' },
  { id: 'c', subject: 'S2', answer: 1, options: ['x', 'y'], question: 'qc', explanation: 'because' },
];
const r = scoreExam(qs, [1, 1, null]); // a 對、b 錯、c 未作答(錯)
assert.equal(r.correct, 1);
assert.equal(r.wrong, 2);
assert.deepEqual(r.wrongIds, ['b', 'c']);
assert.equal(r.percent, 33.3);

// 統計 + 錯題
const prog = {
  a: { box: 5, attempts: 5, correct: 5, wrong: 0 },
  b: { box: 1, attempts: 2, correct: 0, wrong: 2 },
};
const st = progressStats(qs, prog);
assert.equal(st.practiced, 2);
assert.equal(st.mastered, 1);
assert.equal(st.wrongNow, 1);
const s1 = st.subjects.find((s) => s.subject === 'S1');
assert.equal(s1.accuracy, 71.4); // 5 correct / 7 attempts
assert.deepEqual(wrongQuestionIds(qs, prog), ['b']);

// markdown 匯出(收星標)
const md = toMarkdown(qs, { c: { starred: true, note: '記得 RAG' } });
assert.ok(md.includes('[S2]'));
assert.ok(md.includes('A. x'), '要列出所有選項');
assert.ok(md.includes('B. y ✓（正解）'), '正解選項要標 ✓');
assert.ok(md.includes('我的筆記：記得 RAG'));
assert.ok(!md.includes('qa'), '沒星標也沒筆記的不該出現');

// 有筆記但沒星標也要收(筆記不漏)
const md2 = toMarkdown(qs, { a: { note: '只有筆記沒星標' } });
assert.ok(md2.includes('只有筆記沒星標'), '有筆記就該收');
assert.ok(md2.includes('qa'));

// Notion Markdown 測試(含 Active Recall <details> 摺疊)
import { toNotionMarkdown, buildNotionPagePayload } from './core.js';
const nmd = toNotionMarkdown(qs, { c: { starred: true, note: '偏差與變異' } });
assert.ok(nmd.includes('<details>'));
assert.ok(nmd.includes('<summary>'));
assert.ok(nmd.includes('偏差與變異'));

// Notion Page Payload 測試
const payload = buildNotionPagePayload(
  { id: 't1', level: '初級', subject: '科目1：人工智慧基礎概論', chapter: '模型評估', topic: '偏差與變異權衡', question: '問題內容', options: ['A', 'B', 'C', 'D'], answer: 3, explanation: '解析' },
  { box: 2, wrong: 1, note: '重點筆記' },
  'test-db-id',
  { properties: { Name: { type: 'title' }, Level: { type: 'select' } } }
);
assert.equal(payload.parent.database_id, 'test-db-id');
assert.ok(payload.properties.Name.title[0].text.content.includes('偏差與變異權衡'));
assert.equal(payload.properties.Level.select.name, '初級');
assert.ok(payload.children.some((c) => c.type === 'toggle'));

console.log('PASS');

// ---- guessLevel / nextExam ----
import { guessLevel, nextExam } from './core.js';
const bId = (n) => `114-4-b-s1-q${n}`, mId = (n) => `114-2-m-s1-q${n}`;
const mk = (ids) => Object.fromEntries(ids.map((i) => [i, { box: 1 }]));

assert.equal(guessLevel(mk([1,2,3,4,5,6].map(bId))), '初級');
assert.equal(guessLevel(mk([1,2,3,4,5,6].map(mId))), '中級');
assert.equal(guessLevel(mk([...[1,2,3].map(bId), ...[1,2,3].map(mId)])), null, '五五波不猜');
assert.equal(guessLevel(mk([bId(1), bId(2)])), null, '題數太少不猜');
assert.equal(guessLevel({}), null);
assert.equal(guessLevel(null), null, '沒有 progress 不能爆');
// 學習指引題的 id 沒有梯次前綴,一樣要算進去
assert.equal(guessLevel(mk(['lg-b-s1-q1','lg-b-s1-q2','lg-b-s2-q3','lg-b-s2-q4','lg-b-s2-q5'])), '初級');
// 8:2 偏一邊 → 判得出來
assert.equal(guessLevel(mk([...[1,2,3,4,5,6,7,8].map(bId), ...[1,2].map(mId)])), '初級');

const EX = { 初級: ['2026-08-15', '2026-11-07'], 中級: ['2026-05-23', '2026-11-14'] };
assert.deepEqual(nextExam(EX, '2026-08-17'), { level: '初級', date: '2026-11-07' }, '跨級取最近的一場');
assert.deepEqual(nextExam(EX, '2026-08-17', '中級'), { level: '中級', date: '2026-11-14' });
assert.deepEqual(nextExam(EX, '2026-08-15', '初級'), { level: '初級', date: '2026-08-15' }, '考試當天還算數');
assert.equal(nextExam(EX, '2027-01-01'), null, '全部過期回 null');
assert.equal(nextExam({}, '2026-08-17'), null);

import { cardToNotionMarkdown } from './core.js';
const testCard = {
  id: 'c1-linreg',
  category: '數值預測任務',
  title: '線性迴歸 (Linear Regression)',
  subtitle: '尋找最佳直線',
  function: '預測連續數值',
  scenario: '預測房價',
  trap: '不能做分類',
  keywords: ['線性迴歸', '迴歸']
};
const cardMd = cardToNotionMarkdown(testCard);
assert.ok(cardMd.includes('線性迴歸 (Linear Regression)'));
assert.ok(cardMd.includes('數值預測任務'));
assert.ok(cardMd.includes('預測連續數值'));
assert.ok(cardMd.includes('不能做分類'));

import { calcNextReview, formatReviewDue } from './core.js';
const now = 1000000000000;
const r1 = calcNextReview(0, true, now);
assert.equal(r1.stage, 1);
assert.equal(r1.days, 1);
assert.equal(r1.due, now + 86400000);

const r2 = calcNextReview(1, true, now);
assert.equal(r2.stage, 2);
assert.equal(r2.days, 3);
assert.equal(r2.due, now + 3 * 86400000);

const rFail = calcNextReview(3, false, now);
assert.equal(rFail.stage, 1);
assert.equal(rFail.days, 1);

const dueFmt = formatReviewDue(now - 1000, now);
assert.equal(dueFmt.isDue, true);
assert.equal(dueFmt.label, '今日到期待複習');

const futureFmt = formatReviewDue(now + 86400000 * 3, now);
assert.equal(futureFmt.isDue, false);
assert.equal(futureFmt.label, '3 天後複習');

console.log('PASS (含 guessLevel / nextExam / cardToNotionMarkdown / Ebbinghaus)');

// ---- diagnoseStudentAnswer & parseExplanationOptions 測試 ----
import { parseExplanationOptions, diagnoseStudentAnswer } from './core.js';

const sampleQ = {
  id: 'test-q1',
  level: '初級',
  subject: '科目1：人工智慧基礎概論',
  chapter: '機器學習',
  topic: '特徵工程',
  question: '何種技術最適合用來結合兩個具交互作用的欄位？',
  options: ['One-hot 編碼', '正規化', '特徵交叉', '主成分分析'],
  answer: 2,
  explanation: '正解 (C)。「特徵交叉(Feature Cross)」是把兩個特徵組合成新特徵。(A) One-hot 只是把單一類別轉成向量；(B) 正規化只是數值縮放；(D) PCA 是降維。',
};

const parsedOpts = parseExplanationOptions(sampleQ.explanation);
assert.equal(parsedOpts['C'], '「特徵交叉(Feature Cross)」是把兩個特徵組合成新特徵');
assert.ok(parsedOpts['A'].includes('One-hot'));
assert.ok(parsedOpts['B'].includes('正規化'));
assert.ok(parsedOpts['D'].includes('PCA'));

// 測試考生選對且有思路
const diagCorrect = diagnoseStudentAnswer(sampleQ, 2, '我選特徵交叉，因為可以捕捉欄位之間的非線性交互關係，A 只是 one-hot。');
assert.equal(diagCorrect.isCorrect, true);
assert.equal(diagCorrect.pickedLetter, 'C');
assert.ok(diagCorrect.statusSummary.includes('選擇正解'));
assert.ok(diagCorrect.optionBreakdowns.length === 4);

// 測試考生選錯 (選 A)
const diagWrong = diagnoseStudentAnswer(sampleQ, 0, '我覺得是 One-hot 編碼');
assert.equal(diagWrong.isCorrect, false);
assert.equal(diagWrong.pickedLetter, 'A');
assert.equal(diagWrong.correctLetter, 'C');
assert.ok(diagWrong.statusSummary.includes('選擇非正解'));
assert.ok(diagWrong.advice.includes('One-hot'));

// 空解析與「略」邊界測試（防範 null 展開崩潰）
const qEmpty = { id: 't-empty', level: '初級', question: '題幹', options: ['A','B','C','D'], answer: 0, explanation: '' };
const dEmpty = diagnoseStudentAnswer(qEmpty, 0, '隨手作答');
assert.equal(dEmpty.isCorrect, true);
assert.equal(dEmpty.explanation, '');

const qLue = { id: 't-lue', level: '初級', question: '題幹', options: ['A','B','C','D'], answer: 0, explanation: '略' };
const dLue = diagnoseStudentAnswer(qLue, 0, '略過');
assert.equal(dLue.isCorrect, true);

// 否定詞與反向誤解檢測
const sampleQNeg = {
  id: 'test-neg',
  level: '初級',
  subject: '機器學習',
  topic: '監督式學習',
  chapter: '機器學習基礎',
  question: '關於監督式學習的敘述何者正確？',
  options: ['需要標記資料', '不需要標記資料', '完全不用資料', '只用隨機數'],
  answer: 0,
  explanation: '正解 (A)。監督式學習需要標記資料進行訓練。(B) 不需要標記資料的是非監督式學習。',
};
const dNeg = diagnoseStudentAnswer(sampleQNeg, 0, '監督式學習不需要標記資料');
assert.equal(dNeg.hasNegation, true);
assert.ok(dNeg.advice.includes('注意') || dNeg.advice.includes('否定'));
assert.ok(!dNeg.advice.includes('思路清晰！精準掌握'));

console.log('PASS (含 parseExplanationOptions & diagnoseStudentAnswer & edge cases)');

// ---- 同步分歧與統計快照一致性測試 (mergeStores) ----
import { mergeStores } from './core.js';

// 測試 1 (AC-07)：A、B 裝置各作答一次（一端對、一端錯），兩筆唯一作答皆保留且冪等
const devA_event = {
  q: {
    'q-ac07': {
      box: 2,
      attempts: 1,
      correct: 1,
      wrong: 0,
      logs: [{ id: 'evt-A-1', t: 1000, c: true }],
      lastAnsweredAt: 1000,
      updatedAt: 1000,
    }
  }
};
const devB_event = {
  q: {
    'q-ac07': {
      box: 1,
      attempts: 1,
      correct: 0,
      wrong: 1,
      logs: [{ id: 'evt-B-1', t: 2000, c: false }],
      lastAnsweredAt: 2000,
      updatedAt: 2000,
    }
  }
};
const mergedAC07 = mergeStores(devA_event, devB_event);
const resAC07 = mergedAC07.q['q-ac07'];
assert.equal(resAC07.attempts, 2, 'AC-07: 兩端各作答一次，合併後作答次數必須保留為 2');
assert.equal(resAC07.correct, 1, 'AC-07: 答對次數為 1');
assert.equal(resAC07.wrong, 1, 'AC-07: 答錯次數為 1');
assert.equal(resAC07.logs.length, 2, 'AC-07: 兩筆唯一作答 event log 皆保留');

// AC-07 反覆同步冪等性 (Idempotent)
const mergedRepeatedA = mergeStores(mergedAC07, devA_event);
assert.equal(mergedRepeatedA.q['q-ac07'].attempts, 2, 'AC-07: 再次與 A 同步作答次數仍為 2');
assert.equal(mergedRepeatedA.q['q-ac07'].correct, 1);
assert.equal(mergedRepeatedA.q['q-ac07'].wrong, 1);

const mergedRepeatedB = mergeStores(mergedRepeatedA, devB_event);
assert.equal(mergedRepeatedB.q['q-ac07'].attempts, 2, 'AC-07: 再次與 B 同步作答次數仍為 2');
assert.equal(mergedRepeatedB.q['q-ac07'].correct, 1);
assert.equal(mergedRepeatedB.q['q-ac07'].wrong, 1);

// 測試 1-B (舊版無 logs 相容)：兩端各作答一次，舊快照自洽取最新，絕不各取 max 產生 1, 1, 1 矛盾
const devA_legacy = {
  q: {
    'q-div-legacy': { box: 2, attempts: 1, correct: 1, wrong: 0, lastAnsweredAt: 1000, updatedAt: 1000 }
  }
};
const devB_legacy = {
  q: {
    'q-div-legacy': { box: 1, attempts: 1, correct: 0, wrong: 1, lastAnsweredAt: 2000, updatedAt: 2000 }
  }
};
const mergedLegacy = mergeStores(devA_legacy, devB_legacy);
const resLeg = mergedLegacy.q['q-div-legacy'];
assert.equal(resLeg.attempts, 1, '舊格式作答次數應自洽為 1');
assert.equal(resLeg.correct + resLeg.wrong, 1, '答對與答錯總和必須等於作答次數');
assert.ok(!(resLeg.correct === 1 && resLeg.wrong === 1), '嚴禁出現 correct:1 與 wrong:1 同時存在的統計矛盾！');

// 測試 2：Device A 模考作答 2 次，Device B 僅 1 次但有較新筆記 -> 作答次數保持 2 次且筆記更新
const devA_mock = {
  q: {
    'q-div-2': { box: 2, attempts: 2, correct: 1, wrong: 1, lastAnsweredAt: 3000, updatedAt: 3000, note: '' }
  }
};
const devB_note = {
  q: {
    'q-div-2': { box: 1, attempts: 1, correct: 1, wrong: 0, lastAnsweredAt: 1000, updatedAt: 4000, note: '最新重點筆記', noteUpdatedAt: 4000 }
  }
};
const mergedMock = mergeStores(devA_mock, devB_note);
const resMock = mergedMock.q['q-div-2'];
assert.equal(resMock.attempts, 2, '模考 2 次作答絕不可退回 1 次');
assert.equal(resMock.correct, 1);
assert.equal(resMock.wrong, 1);
assert.equal(resMock.note, '最新重點筆記', '應保留較新筆記');

// 測試 3：清空刪除筆記不會被舊資料復活
const devA_delNote = {
  q: {
    'q-div-3': { attempts: 1, correct: 1, wrong: 0, note: '', noteUpdatedAt: 5000, updatedAt: 5000 }
  }
};
const devB_oldNote = {
  q: {
    'q-div-3': { attempts: 1, correct: 1, wrong: 0, note: '舊筆記內容', noteUpdatedAt: 4000, updatedAt: 4000 }
  }
};
const mergedDel = mergeStores(devB_oldNote, devA_delNote);
assert.equal(mergedDel.q['q-div-3'].note, '', '刪除筆記絕不可被舊資料復活');

// 測試 4：取消星標不會被舊資料復活
const devA_unstar = {
  q: {
    'q-div-4': { attempts: 1, correct: 1, wrong: 0, starred: false, starredUpdatedAt: 5000, updatedAt: 5000 }
  }
};
const devB_star = {
  q: {
    'q-div-4': { attempts: 1, correct: 1, wrong: 0, starred: true, starredUpdatedAt: 4000, updatedAt: 4000 }
  }
};
const mergedUnstar = mergeStores(devB_star, devA_unstar);
assert.equal(mergedUnstar.q['q-div-4'].starred, false, '取消星標絕不可被舊資料復活');

// 測試 5 (AC-08)：重設統計版本隔離，拉取舊備份時不復活舊作答，且保留筆記、解題思路與星標
const devA_reset = {
  statsResetAt: 5000,
  updatedAt: 5000,
  q: {
    'q-ac08': {
      box: 1,
      attempts: 0,
      correct: 0,
      wrong: 0,
      logs: [],
      note: '重設後保留的筆記',
      noteUpdatedAt: 5000,
      studentAnswer: '重設後保留的思路',
      starred: true,
      starredUpdatedAt: 5000,
      lastAnsweredAt: 0,
      updatedAt: 5000,
    }
  }
};
const devB_oldBackup = {
  statsResetAt: 0,
  updatedAt: 4000,
  q: {
    'q-ac08': {
      box: 2,
      attempts: 5,
      correct: 4,
      wrong: 1,
      logs: [
        { id: 'old-1', t: 1000, c: true },
        { id: 'old-2', t: 2000, c: true },
        { id: 'old-3', t: 3000, c: false },
        { id: 'old-4', t: 3500, c: true },
        { id: 'old-5', t: 4000, c: true },
      ],
      note: '舊備份筆記',
      noteUpdatedAt: 3000,
      studentAnswer: '舊思路',
      starred: false,
      starredUpdatedAt: 3000,
      lastAnsweredAt: 4000,
      updatedAt: 4000,
    }
  }
};

const mergedReset = mergeStores(devA_reset, devB_oldBackup);
const resReset = mergedReset.q['q-ac08'];
assert.equal(resReset.attempts, 0, 'AC-08: 早期作答紀錄絕不可被舊備份復活，attempts 應為 0');
assert.equal(resReset.correct, 0, 'AC-08: correct 應為 0');
assert.equal(resReset.wrong, 0, 'AC-08: wrong 應為 0');
assert.deepEqual(resReset.logs, [], 'AC-08: logs 應清空');
assert.equal(resReset.note, '重設後保留的筆記', 'AC-08: 筆記完整保留');
assert.equal(resReset.studentAnswer, '重設後保留的思路', 'AC-08: 考生思路完整保留');
assert.equal(resReset.starred, true, 'AC-08: 星標完整保留');
assert.equal(mergedReset.statsResetAt, 5000, 'AC-08: statsResetAt 戳記保留');

console.log('PASS (含 mergeStores 統計自洽快照與同步分歧測試)');

// 引入 Notion 正文原子更新、錯誤傳遞與狀態防護測試
import './notion_sync.test.mjs';
