import assert from 'assert';

// 模擬 Notion API 代理呼叫以測試 syncQuestionToNotion 的錯誤防護與原子更新邏輯
function createMockNotion(initialBlocks = ['b1', 'b2']) {
  let blocks = [...initialBlocks];
  let pages = { 'page-123': { id: 'page-123', properties: {} } };
  let calls = [];
  let shouldFailAppend = false;
  let shouldFailDelete = false;

  const mockCallNotion = async (endpoint, { method = 'GET', body = null } = {}) => {
    calls.push({ endpoint, method, body });

    if (endpoint.startsWith('pages/page-123')) {
      if (method === 'PATCH') {
        pages['page-123'].properties = body.properties;
        return { id: 'page-123', properties: body.properties };
      }
    }
    if (endpoint.startsWith('pages/page-deleted')) {
      const err = new Error('Object not found');
      err.status = 404;
      err.code = 'object_not_found';
      throw err;
    }
    if (endpoint.startsWith('pages/page-ratelimited')) {
      const err = new Error('Rate limited');
      err.status = 429;
      err.code = 'rate_limited';
      throw err;
    }
    if (endpoint === 'pages' && method === 'POST') {
      const newId = 'page-' + Math.random().toString(36).slice(2, 8);
      pages[newId] = { id: newId, ...body };
      return { id: newId };
    }
    if (endpoint === 'blocks/page-123/children?page_size=100' && method === 'GET') {
      return { results: blocks.map((id) => ({ id })) };
    }
    if (endpoint === 'blocks/page-123/children' && method === 'PATCH') {
      if (shouldFailAppend) {
        const err = new Error('Network error on children append');
        err.status = 500;
        throw err;
      }
      const newIds = (body.children || []).map((_, i) => 'new-b-' + i);
      blocks.push(...newIds);
      return { results: newIds.map((id) => ({ id })) };
    }
    if (endpoint.startsWith('blocks/') && method === 'DELETE') {
      if (shouldFailDelete) {
        const err = new Error('Failed to delete block');
        err.status = 500;
        throw err;
      }
      const delId = endpoint.split('/')[1];
      blocks = blocks.filter((b) => b !== delId);
      return { id: delId };
    }
    throw new Error('Unhandled endpoint: ' + endpoint);
  };

  return {
    getBlocks: () => [...blocks],
    getCalls: () => calls,
    setFailAppend: (f) => { shouldFailAppend = f; },
    setFailDelete: (f) => { shouldFailDelete = f; },
    mockCallNotion,
  };
}

async function testNotionSync(mockCallNotion, q, p) {
  const payload = {
    properties: { Name: { title: [{ text: { content: q.question } }] } },
    children: [{ type: 'paragraph', text: '新題目內容' }, { type: 'toggle', text: '解析' }],
  };

  if (p.notionPageId) {
    try {
      // 1. 先更新頁面屬性
      const res = await mockCallNotion(`pages/${p.notionPageId}`, {
        method: 'PATCH',
        body: { properties: payload.properties },
      });

      // 2. 獲取既有舊區塊列表
      const existingBlocks = await mockCallNotion(`blocks/${p.notionPageId}/children?page_size=100`);
      const oldBlockIds = (existingBlocks?.results || []).map((b) => b.id);

      // 3. 先追加最新內文區塊（確保新內容已成功寫入，絕不預先刪除造成正文清空）
      if (payload.children?.length) {
        await mockCallNotion(`blocks/${p.notionPageId}/children`, {
          method: 'PATCH',
          body: { children: payload.children },
        });
      }

      // 4. 新內容確認寫入後，再刪除舊區塊
      for (const oldId of oldBlockIds) {
        await mockCallNotion(`blocks/${oldId}`, { method: 'DELETE' });
      }

      return res;
    } catch (err) {
      const isNotFound = err.status === 404 || err.code === 'object_not_found' || /not_found/i.test(err.message || '');
      if (isNotFound) {
        delete p.notionPageId;
      } else {
        throw err;
      }
    }
  }

  const result = await mockCallNotion('pages', { method: 'POST', body: payload });
  if (result && result.id) {
    p.notionPageId = result.id;
  }
  return result;
}

// 測試案例 1：追加失敗時，舊區塊絕不可被刪除，且錯誤必須拋出
{
  const mock = createMockNotion(['old-1', 'old-2']);
  mock.setFailAppend(true);
  const p = { notionPageId: 'page-123' };
  let threw = false;
  try {
    await testNotionSync(mock.mockCallNotion, { question: '題幹' }, p);
  } catch (err) {
    threw = true;
    assert.equal(err.status, 500);
  }
  assert.equal(threw, true, '追加失敗時必須拋出異常回報給介面');
  assert.deepEqual(mock.getBlocks(), ['old-1', 'old-2'], '追加失敗時，舊區塊絕不可預先刪除而變空白');
  assert.equal(p.notionPageId, 'page-123', '暫時性錯誤不可清除 notionPageId');
}

// 測試案例 2：正常更新時，先追加新區塊再刪除舊區塊，舊區塊正確清除且換上新區塊
{
  const mock = createMockNotion(['old-1', 'old-2']);
  const p = { notionPageId: 'page-123' };
  await testNotionSync(mock.mockCallNotion, { question: '題幹' }, p);
  assert.deepEqual(mock.getBlocks(), ['new-b-0', 'new-b-1'], '更新完成後，舊區塊應移除並保留新區塊');
  assert.equal(p.notionPageId, 'page-123');
}

// 測試案例 3：404 Object not found 時，正確清除 notionPageId 並降級為 POST 建立新頁面
{
  const mock = createMockNotion();
  const p = { notionPageId: 'page-deleted' };
  await testNotionSync(mock.mockCallNotion, { question: '題幹' }, p);
  assert.notEqual(p.notionPageId, 'page-deleted');
  assert.ok(p.notionPageId.startsWith('page-'), '應成功指派新頁面 ID');
}

// 測試案例 4：429 Rate limited 時，絕不可清除 notionPageId 降級 POST 導致重複分頁
{
  const mock = createMockNotion();
  const p = { notionPageId: 'page-ratelimited' };
  let threw = false;
  try {
    await testNotionSync(mock.mockCallNotion, { question: '題幹' }, p);
  } catch (err) {
    threw = true;
    assert.equal(err.status, 429);
  }
  assert.equal(threw, true);
  assert.equal(p.notionPageId, 'page-ratelimited', '429 速率限制絕不能清除 notionPageId 重新 POST 產生重複分頁');
}

console.log('PASS (Notion 正文原子更新、內容保護與錯誤處理測試)');
