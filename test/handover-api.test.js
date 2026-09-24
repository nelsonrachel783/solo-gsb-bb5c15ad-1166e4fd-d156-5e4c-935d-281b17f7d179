'use strict';

/* 人员交接责任单只读接口集成测试：node test/handover-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-handover-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function getJson(url) {
  const res = await fetch(`${base}${url}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 演示数据：
  // 青龙剑：仓库→张三[0]→李四[3]→张三[8]→仓库[12]
  // 折扇：仓库→张三[1]；第 5 分钟张三同时交给王五 / 赵六 -> 歧义冲突
  // 宫灯：仓库→王五[2]；第 4 分钟李四→钱七断链；第 9 分钟钱七→仓库（不可接续）
  // 御印：仓库→周八[1]→孙七[6]
  const state0 = (await getJson('/api/state')).body;
  const rev0 = state0.rev;

  const q = (person, fromMinute, toMinute) =>
    `/api/handovers/person?${new URLSearchParams({ person, fromMinute: String(fromMinute), toMinute: String(toMinute) })}`;

  // 1. 全窗口责任单：收支次序、持有汇总、无法判定分列
  await test('张三 0..12：逐次收支 + 窗口内两件冲突道具单列', async () => {
    const res = await getJson(q('张三', 0, 12));
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.person, '张三');
    assert.strictEqual(r.fromMinute, 0);
    assert.strictEqual(r.toMinute, 12);
    assert.deepStrictEqual(
      r.events.map((e) => `${e.minute}:${e.type}:${e.propName}`),
      [
        '0:RECEIVE:青龙剑',
        '3:GIVE:青龙剑',
        '8:RECEIVE:青龙剑',
        '12:GIVE:青龙剑',
      ]
    );
    // 对应记录编号均能在全量记录中找到
    for (const e of r.events) {
      assert.ok(state0.records.some((x) => x.id === e.recordId), `记录 ${e.recordId} 应存在`);
    }
    // 第 0 分钟交接前道具都在仓库，张三不持有；第 12 分钟交接完成后剑已归仓
    assert.deepStrictEqual(r.heldBefore, []);
    assert.deepStrictEqual(r.heldAfter, []);
    // 折扇（窗口内歧义，第 5 分）、宫灯（窗口内断链，第 4 分）均无法判定
    const unknown = r.undetermined.map((u) => `${u.propName}:${u.phase}:${u.conflictMinute}`);
    assert.ok(unknown.includes('宫灯:IN_WINDOW:4'));
    assert.ok(unknown.includes('折扇:IN_WINDOW:5'));
    assert.strictEqual(r.summary.receiveCount, 2);
    assert.strictEqual(r.summary.giveCount, 2);
    assert.strictEqual(r.summary.undeterminedCount, 2);
  });

  // 2. 窗口后的冲突不影响本次结果；终点持有正确
  await test('张三 0..3：第 4/5 分钟冲突在窗口后不计，终点持有折扇', async () => {
    const res = await getJson(q('张三', 0, 3));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.events.map((e) => `${e.minute}:${e.type}:${e.propName}`),
      ['0:RECEIVE:青龙剑', '1:RECEIVE:折扇', '3:GIVE:青龙剑']
    );
    assert.deepStrictEqual(res.body.undetermined, []);
    assert.deepStrictEqual(res.body.heldBefore, []);
    assert.deepStrictEqual(res.body.heldAfter.map((h) => h.propName), ['折扇']);
    assert.strictEqual(res.body.heldAfter[0].sinceMinute, 1);
  });

  // 3. 窗口前冲突：BEFORE 阶段，窗口内该人的接收也不计入收支
  await test('钱七 5..12：宫灯第 4 分钟断链属窗口前冲突，无法判定', async () => {
    const res = await getJson(q('钱七', 5, 12));
    assert.strictEqual(res.status, 200);
    // 钱七的收支：只有宫灯第 9 分钟「钱七→仓库」可能涉及，但该道具窗口前已断链 -> 整件排除
    assert.deepStrictEqual(res.body.events, []);
    assert.deepStrictEqual(res.body.heldBefore, []);
    assert.deepStrictEqual(res.body.heldAfter, []);
    const lantern = res.body.undetermined.find((u) => u.propName === '宫灯');
    assert.ok(lantern, '宫灯应列为无法判定');
    assert.strictEqual(lantern.phase, 'BEFORE');
    assert.strictEqual(lantern.conflictMinute, 4);
    // 折扇第 5 分钟歧义恰在窗口起点（含），属窗口内冲突
    const fan = res.body.undetermined.find((u) => u.propName === '折扇');
    assert.ok(fan, '折扇应列为无法判定');
    assert.strictEqual(fan.phase, 'IN_WINDOW');
    assert.strictEqual(fan.conflictMinute, 5);
  });

  // 4. 同分钟链式交接按实际接续顺序：李四第 3 分接收、第 8 分交出青龙剑
  await test('李四 3..8：接收与交出青龙剑，起点 / 终点均不持有', async () => {
    const res = await getJson(q('李四', 3, 8));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.events.map((e) => `${e.minute}:${e.type}:${e.propName}`),
      ['3:RECEIVE:青龙剑', '8:GIVE:青龙剑']
    );
    assert.deepStrictEqual(res.body.heldBefore, []);
    assert.deepStrictEqual(res.body.heldAfter, []);
    // 青龙剑链完整，不在无法判定之列（宫灯 / 折扇的冲突与李四无关，另行列示）
    assert.ok(!res.body.undetermined.some((u) => u.propName === '青龙剑'));
  });

  // 5. 参数校验
  await test('参数校验：缺人员 / 分钟非法 / 起止颠倒均 400', async () => {
    let res = await getJson('/api/handovers/person?fromMinute=0&toMinute=5');
    assert.strictEqual(res.status, 400);
    assert.ok(/人员/.test(res.body.error));

    res = await getJson(q('张三', -1, 5));
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟/.test(res.body.error));

    res = await getJson(q('张三', 0, 2.5));
    assert.strictEqual(res.status, 400);
    assert.ok(/截止分钟/.test(res.body.error));

    res = await getJson(q('张三', 9, 5));
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟不能大于截止分钟/.test(res.body.error));
  });

  // 6. 只读：多次查询不改变数据版本
  await test('只读：查询前后数据版本 rev 不变', async () => {
    await getJson(q('张三', 0, 12));
    await getJson(q('李四', 3, 8));
    const after = (await getJson('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, state0.records.length);
  });

  // 7. 无关人员：空收支、空持有，无冲突道具时无法判定也为空
  await test('路人甲 0..12：空收支；冲突道具仍如实单列', async () => {
    const res = await getJson(q('路人甲', 0, 12));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.events, []);
    assert.deepStrictEqual(res.body.heldBefore, []);
    assert.deepStrictEqual(res.body.heldAfter, []);
    // 与查询人无关，但窗口内确有链冲突的两件道具仍如实单列
    assert.strictEqual(res.body.undetermined.length, 2);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个人员交接责任单接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
