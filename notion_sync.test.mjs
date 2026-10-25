import assert from 'node:assert';
import { syncQuestionToNotion } from './core.js';

// 模擬 Notion API 代理呼叫以測試正式 export 的 syncQuestionToNotion 函式
function createMockNotionServer() {
  const pages = new Map(); // pageId -> { id, properties, database_id }
  const blocks = new Map(); // blockId -> { id, parentId, type, content }
  const pageChildren = new Map(); // pageId -> [blockId]
  const calls = [];

  let failAppend = false;
  let failBlockDelete = false;

  const mockCallNotion = async (endpoint, { method = 'GET', body = null } = {}) => {
    calls.push({ endpoint, method, body });

    // 1. POST pages (建立新頁面)
    if (endpoint === 'pages' && method === 'POST') {
      const pageId = 'page-' + Math.random().toString(36).slice(2, 9);
      pages.set(pageId, { id: pageId, properties: body.properties, parent: body.parent });
      const childIds = [];
      if (body.children) {
        for (const child of body.children) {
          const bid = 'b-' + Math.random().toString(36).slice(2, 9);
          blocks.set(bid, { id: bid, parentId: pageId, ...child });
          childIds.push(bid);
        }
      }
      pageChildren.set(pageId, childIds);
      return { id: pageId, properties: body.properties };
    }

    // 2. PATCH pages/:id (更新頁面屬性)
    if (endpoint.startsWith('pages/') && method === 'PATCH') {
      const pageId = endpoint.replace('pages/', '');
      if (pageId === 'page-rate-limited') {
        const err = new Error('Rate limit exceeded');
        err.status = 429;
        err.code = 'rate_limited';
        throw err;
      }
      if (pageId === 'page-deleted' || !pages.has(pageId)) {
        const err = new Error('Object not found');
        err.status = 404;
        err.code = 'object_not_found';
        throw err;
      }
      const existing = pages.get(pageId);
      existing.properties = body.properties;
      return { id: pageId, properties: body.properties };
    }

    // 3. GET blocks/:pageId/children (讀取區塊列表，含分頁)
    if (endpoint.startsWith('blocks/') && endpoint.includes('/children') && method === 'GET') {
      const pageId = endpoint.split('/')[1];
      const children = pageChildren.get(pageId) || [];

      // 模擬分頁測試：若包含 page_size 且特定頁面模擬 cursor
      if (endpoint.includes('page_size=100')) {
        if (pageId === 'page-paginated') {
          if (!endpoint.includes('start_cursor=')) {
            return {
              results: children.slice(0, 2).map((id) => ({ id })),
              has_more: true,
              next_cursor: 'cursor-page-2',
            };
          } else if (endpoint.includes('start_cursor=cursor-page-2')) {
            return {
              results: children.slice(2).map((id) => ({ id })),
              has_more: false,
              next_cursor: null,
            };
          }
        }
      }

      return {
        results: children.map((id) => ({ id })),
        has_more: false,
        next_cursor: null,
      };
    }

    // 4. PATCH blocks/:pageId/children (追加新區塊)
    if (endpoint.startsWith('blocks/') && endpoint.endsWith('/children') && method === 'PATCH') {
      if (failAppend) {
        const err = new Error('Notion internal server error during append');
        err.status = 500;
        throw err;
      }
      const pageId = endpoint.split('/')[1];
      const newBlockIds = [];
      const currentList = pageChildren.get(pageId) || [];
      for (const child of (body.children || [])) {
        const bid = 'b-' + Math.random().toString(36).slice(2, 9);
        blocks.set(bid, { id: bid, parentId: pageId, ...child });
        newBlockIds.push(bid);
      }
      pageChildren.set(pageId, [...currentList, ...newBlockIds]);
      return { results: newBlockIds.map((id) => ({ id })) };
    }

    // 5. DELETE blocks/:blockId (刪除指定區塊)
    if (endpoint.startsWith('blocks/') && method === 'DELETE') {
      const blockId = endpoint.replace('blocks/', '');
      if (failBlockDelete) {
        const err = new Error('Delete block server error');
        err.status = 500;
        throw err;
      }
      if (blockId === 'already-deleted-block' || !blocks.has(blockId)) {
        const err = new Error('Block not found');
        err.status = 404;
        err.code = 'object_not_found';
        throw err;
      }
      blocks.delete(blockId);
      for (const [pid, list] of pageChildren.entries()) {
        pageChildren.set(pid, list.filter((id) => id !== blockId));
      }
      return { id: blockId };
    }

    throw new Error('Unhandled endpoint in mock Notion server: ' + endpoint);
  };

  return {
    pages,
    blocks,
    pageChildren,
    calls,
    setFailAppend: (f) => { failAppend = f; },
    setFailBlockDelete: (f) => { failBlockDelete = f; },
    mockCallNotion,
  };
}

const sampleQ = {
  id: 'test-q-notion',
  level: '初級',
  subject: '科目1：人工智慧基礎概論',
  chapter: '機器學習',
  topic: '監督式學習',
  question: '測試問題題幹',
  options: ['A選項', 'B選項', 'C選項', 'D選項'],
  answer: 0,
  explanation: '正解 (A)。詳解內容。',
};

// 案例 1：首次同步 (POST) 正確建立頁面並初始化 notionPageId 與 notionBlockIds
{
  const mock = createMockNotionServer();
  const p = { box: 2, note: '個人重點筆記' };
  const res = await syncQuestionToNotion(sampleQ, p, {
    dbId: 'db-test-1',
    callNotion: mock.mockCallNotion,
  });
  assert.ok(p.notionPageId, '首次建立必須設定 notionPageId');
  assert.ok(mock.pages.has(p.notionPageId), 'Notion 服務端應存有此頁面');
  assert.ok(Array.isArray(p.notionBlockIds) && p.notionBlockIds.length > 0, '首次建立應記錄系統產生的區塊 ID');
}

// 案例 2：重複同步正常更新：PATCH properties -> PATCH children -> 刪除舊系統區塊
{
  const mock = createMockNotionServer();
  const p = { box: 2, note: '第一版筆記' };
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  const initialPageId = p.notionPageId;

  // 考生更新筆記後再次同步
  p.note = '第二版修正筆記';
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });

  assert.equal(p.notionPageId, initialPageId, '重複同步應原地更新，不建立重複頁面');
  assert.ok(p.notionBlockIds.length > 0, '應記錄系統最新管理的區塊 ID');
}

// 案例 3：追加失敗時 (500)，舊區塊絕不可預先被刪除，且必須拋出錯誤通知介面 (FR-07, AC-10)
{
  const mock = createMockNotionServer();
  const p = { box: 2, note: '初始筆記' };
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  const initialBlocks = [...mock.pageChildren.get(p.notionPageId)];

  mock.setFailAppend(true);
  let threw = false;
  try {
    p.note = '追加會失敗的新筆記';
    await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 500);
  }
  assert.equal(threw, true, '追加失敗時必須拋出異常');
  assert.deepEqual(mock.pageChildren.get(p.notionPageId), initialBlocks, '追加失敗時，舊內容區塊必須完整保留，絕不可變空白！');
}

// 案例 4：刪除舊區塊遇到 404 (object_not_found) 時，視為該區塊已被刪除，絕不可判定為頁面 404 而重新 POST 建立重複頁面！ (FR-07, AC-10)
{
  const mock = createMockNotionServer();
  const p = { box: 1, note: '筆記 1' };
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  const pageId = p.notionPageId;

  // 模擬系統管理區塊中包含已在 Notion 上被手動移除的 block
  p.notionBlockIds = ['already-deleted-block'];
  p.note = '筆記 2';

  const res = await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  assert.equal(p.notionPageId, pageId, '區塊 404 絕不可清空 notionPageId');
  assert.equal(mock.pages.size, 1, '不可重複 POST 新頁面，總頁數仍應為 1');
}

// 案例 5：保護考生自訂內容：只刪除系統管理的 notionBlockIds，考生自己在 Notion 頁面內新增的 block 不會被刪除 (FR-07)
{
  const mock = createMockNotionServer();
  const p = { box: 1, note: '題庫同步筆記' };
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  const pageId = p.notionPageId;

  // 模擬考生在 Notion 該頁面手動新增了一個專用筆記區塊
  const userCustomBlockId = 'b-user-custom-block-id';
  mock.blocks.set(userCustomBlockId, { id: userCustomBlockId, parentId: pageId, type: 'quote', text: '考生自己加的個人筆記' });
  mock.pageChildren.get(pageId).push(userCustomBlockId);

  // 再次由系統同步更新
  p.note = '更新後的題庫筆記';
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });

  // 驗證考生自訂的區塊仍然存在於頁面中
  assert.ok(mock.blocks.has(userCustomBlockId), '考生自行新增的 block 絕不能被系統同步刪除！');
  assert.ok(mock.pageChildren.get(pageId).includes(userCustomBlockId));
}

// 案例 6：分頁支援：未指定 notionBlockIds 時，若舊區塊超過 100 個且有 has_more，需透過 next_cursor 完整遍歷 (FR-07)
{
  const mock = createMockNotionServer();
  const pageId = 'page-paginated';
  mock.pages.set(pageId, { id: pageId, properties: {} });
  // 加入 4 個區塊，createMockNotionServer 會在第一頁回傳前 2 個 + cursor，第二頁回傳後 2 個
  const b1 = 'b-page1-1', b2 = 'b-page1-2', b3 = 'b-page2-1', b4 = 'b-page2-2';
  for (const bid of [b1, b2, b3, b4]) {
    mock.blocks.set(bid, { id: bid, parentId: pageId });
  }
  mock.pageChildren.set(pageId, [b1, b2, b3, b4]);

  const p = { notionPageId: pageId, box: 1, note: '分頁測試' };
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });

  // 驗證 4 個舊區塊都已完整讀取並刪除，只剩新區塊
  assert.equal(mock.blocks.has(b1), false);
  assert.equal(mock.blocks.has(b2), false);
  assert.equal(mock.blocks.has(b3), false);
  assert.equal(mock.blocks.has(b4), false);
  assert.equal(p.notionPageId, pageId);
}

// 案例 7：頁面本身明確 404 時 (例如 Notion 垃圾桶永久刪除)，才清除 notionPageId 並 POST 重新建立 (AC-10)
{
  const mock = createMockNotionServer();
  const p = { notionPageId: 'page-deleted', box: 1, note: '已刪頁面測試' };
  await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  assert.notEqual(p.notionPageId, 'page-deleted');
  assert.ok(p.notionPageId.startsWith('page-'), '頁面 404 後應成功重新建立新頁面');
}

// 案例 8：429 Rate limited 速率限制時，必須拋出異常重試，絕不可誤判為頁面遺失而清除 ID 建立重複頁面 (AC-10)
{
  const mock = createMockNotionServer();
  const p = { notionPageId: 'page-rate-limited', box: 1, note: '限流測試' };
  let threw = false;
  try {
    await syncQuestionToNotion(sampleQ, p, { dbId: 'db-test-1', callNotion: mock.mockCallNotion });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 429);
  }
  assert.equal(threw, true, '429 必須向外拋出錯誤');
  assert.equal(p.notionPageId, 'page-rate-limited', '429 絕不可清除 notionPageId');
}

console.log('PASS (Notion 正文原子更新、內容保護與錯誤處理測試)');
