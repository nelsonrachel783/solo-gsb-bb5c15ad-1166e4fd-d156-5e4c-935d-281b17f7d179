'use strict';

/* 人员交接责任单引擎单元测试：node test/handover.test.js */

const assert = require('assert');
const { personHandovers, EVENT, PHASE } = require('../src/handover');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const names = (items) => items.map((x) => x.propName);
const eventTypes = (result) => result.events.map((e) => `${e.minute}:${e.type}:${e.propName}`);

// 1. 基本收支：起点前持有 + 窗口内接收 / 交出 + 终点后持有
test('责任单：起点前持有、窗口内接收交出、终点后持有', () => {
  // 剑：仓库 -[0]→ 张三 -[3]→ 李四 -[8]→ 张三 -[12]→ 仓库
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 8, '李四', '张三'),
    rec('p0', 12, '张三', WAREHOUSE),
  ]);

  // 张三，窗口 3..12（均含）
  const r = personHandovers(data, '张三', 3, 12);
  assert.deepStrictEqual(eventTypes(r), [
    `3:${EVENT.GIVE}:剑`,
    `8:${EVENT.RECEIVE}:剑`,
    `12:${EVENT.GIVE}:剑`,
  ]);
  // 起点交接前（第 3 分钟交接前）张三持有剑，自第 0 分起
  assert.deepStrictEqual(names(r.heldBefore), ['剑']);
  assert.strictEqual(r.heldBefore[0].sinceMinute, 0);
  // 终点交接后（第 12 分钟交接完成）已归仓，张三不持有
  assert.deepStrictEqual(names(r.heldAfter), []);
  assert.deepStrictEqual(r.undetermined, []);
  assert.strictEqual(r.summary.receiveCount, 1);
  assert.strictEqual(r.summary.giveCount, 2);
});

// 2. 同分钟链式交接按实际接续顺序列出（倒序录入不影响）
test('责任单：同分钟链式交接按实际接续顺序识别', () => {
  // 枪：仓库 -[2]→ 张三；第 7 分钟 张三→李四、李四→王五
  const data = mkData(['枪'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 7, '李四', '王五'), // 故意后接的边先录入
    rec('p0', 7, '张三', '李四'),
  ]);
  const r = personHandovers(data, '李四', 7, 7);
  assert.deepStrictEqual(eventTypes(r), [
    `7:${EVENT.RECEIVE}:枪`,
    `7:${EVENT.GIVE}:枪`,
  ]);
  assert.strictEqual(r.events[0].counterparty, '张三');
  assert.strictEqual(r.events[1].counterparty, '王五');
  assert.strictEqual(r.events[0].chainIndex, 1);
  assert.strictEqual(r.events[1].chainIndex, 2);
  // 两次事项对应两条不同的记录
  assert.notStrictEqual(r.events[0].recordId, r.events[1].recordId);
  // 起点交接前李四不持有；终点交接后枪已交给王五
  assert.deepStrictEqual(r.heldBefore, []);
  assert.deepStrictEqual(r.heldAfter, []);
});

// 3. 窗口起点分钟包含：该分钟的接收计入明细与终点持有
test('责任单：起始分钟包含——窗口从领出当分钟开始', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
  ]);
  const r = personHandovers(data, '张三', 0, 5);
  assert.deepStrictEqual(eventTypes(r), [
    `0:${EVENT.RECEIVE}:剑`,
    `5:${EVENT.GIVE}:剑`,
  ]);
  // 起点交接前（第 0 分钟交接前）在仓库，张三不持有
  assert.deepStrictEqual(r.heldBefore, []);
  assert.deepStrictEqual(r.heldAfter, []);
});

// 4. 截止分钟包含：该分钟交接完成后仍持有 -> 计入终点持有，since 为该分钟
test('责任单：截止分钟包含——当分钟接收计入终点持有', () => {
  const data = mkData(['剑'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 6, '张三', '李四'),
  ]);
  const r = personHandovers(data, '李四', 0, 6);
  assert.deepStrictEqual(eventTypes(r), [`6:${EVENT.RECEIVE}:剑`]);
  assert.deepStrictEqual(names(r.heldAfter), ['剑']);
  assert.strictEqual(r.heldAfter[0].sinceMinute, 6);
});

// 5. 窗口内歧义冲突：无法判定并标明冲突分钟，不计入持有与收支
test('责任单：窗口内多条可接续冲突 -> 无法判定（IN_WINDOW）', () => {
  // 扇：仓库 -[1]→ 张三；第 5 分钟 张三→王五、张三→赵六
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = personHandovers(data, '张三', 0, 9);
  assert.deepStrictEqual(r.events.map((e) => e.propName), []); // 冲突分钟的边均不进入明细
  assert.deepStrictEqual(r.heldBefore, []);
  assert.deepStrictEqual(r.heldAfter, []);
  assert.strictEqual(r.undetermined.length, 1);
  assert.strictEqual(r.undetermined[0].propName, '扇');
  assert.strictEqual(r.undetermined[0].phase, PHASE.IN_WINDOW);
  assert.strictEqual(r.undetermined[0].conflictMinute, 5);
  assert.strictEqual(r.undetermined[0].recordIds.length, 2);
});

// 6. 窗口前冲突：窗口前已断链 -> 无法判定（BEFORE），窗口内记录不产生收支
test('责任单：窗口前断链冲突 -> 无法判定（BEFORE）', () => {
  // 灯：仓库 -[2]→ 王五；第 4 分钟 李四→钱七（断链）；第 9 分钟 钱七→仓库
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
    rec('p0', 9, '钱七', WAREHOUSE),
  ]);
  const r = personHandovers(data, '钱七', 5, 12);
  assert.deepStrictEqual(r.events, []);
  assert.deepStrictEqual(r.heldBefore, []);
  assert.deepStrictEqual(r.heldAfter, []);
  assert.strictEqual(r.undetermined.length, 1);
  assert.strictEqual(r.undetermined[0].phase, PHASE.BEFORE);
  assert.strictEqual(r.undetermined[0].conflictMinute, 4);
});

// 7. 窗口后的冲突不影响本次结果
test('责任单：窗口后冲突不影响责任单', () => {
  // 扇：仓库 -[1]→ 张三；第 9 分钟 张三→王五、张三→赵六（歧义）
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 9, '张三', '王五'),
    rec('p0', 9, '张三', '赵六'),
  ]);
  const r = personHandovers(data, '张三', 0, 5);
  assert.deepStrictEqual(eventTypes(r), [`1:${EVENT.RECEIVE}:扇`]);
  assert.deepStrictEqual(names(r.heldAfter), ['扇']);
  assert.strictEqual(r.heldAfter[0].sinceMinute, 1);
  assert.deepStrictEqual(r.undetermined, []);
});

// 8. 冲突恰发生在截止分钟：包含 -> IN_WINDOW 无法判定
test('责任单：截止分钟冲突 -> IN_WINDOW 无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const at5 = personHandovers(data, '张三', 0, 5);
  assert.strictEqual(at5.undetermined.length, 1);
  assert.strictEqual(at5.undetermined[0].phase, PHASE.IN_WINDOW);
  // 截止分钟取 4：冲突尚未发生，终点仍由张三持有
  const at4 = personHandovers(data, '张三', 0, 4);
  assert.deepStrictEqual(at4.undetermined, []);
  assert.deepStrictEqual(names(at4.heldAfter), ['扇']);
});

// 9. 多道具：逐件独立重放，确定件正常列收支，冲突件单列
test('责任单：多道具混合——确定件与无法判定件分开', () => {
  const data = mkData(['剑', '扇', '印'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', WAREHOUSE),
    rec('p1', 1, WAREHOUSE, '张三'),
    rec('p1', 5, '张三', '王五'),
    rec('p1', 5, '张三', '赵六'), // 窗口内歧义
    rec('p2', 2, WAREHOUSE, '李四'), // 与张三无关
  ]);
  const r = personHandovers(data, '张三', 0, 9);
  // 扇在第 5 分钟冲突 -> 整件道具（含第 1 分钟的接收）不计入收支
  assert.deepStrictEqual(eventTypes(r), [
    `1:${EVENT.RECEIVE}:剑`,
    `4:${EVENT.GIVE}:剑`,
  ]);
  assert.deepStrictEqual(names(r.heldBefore), []);
  assert.deepStrictEqual(r.heldAfter, []);
  assert.deepStrictEqual(names(r.undetermined), ['扇']);
  // 只有剑产生了收支事项（扇整件被排除）
  assert.strictEqual(r.summary.involvedProps, 1);
});

// 10. 收支明细的对方（counterparty）与对应记录正确
test('责任单：接收 / 交出的对方与记录编号正确', () => {
  const r1 = rec('p0', 2, WAREHOUSE, '张三');
  const r2 = rec('p0', 7, '张三', '李四');
  const data = mkData(['剑'], [r1, r2]);
  const r = personHandovers(data, '张三', 0, 9);
  assert.strictEqual(r.events[0].type, EVENT.RECEIVE);
  assert.strictEqual(r.events[0].counterparty, WAREHOUSE);
  assert.strictEqual(r.events[0].recordId, r1.id);
  assert.strictEqual(r.events[1].type, EVENT.GIVE);
  assert.strictEqual(r.events[1].counterparty, '李四');
  assert.strictEqual(r.events[1].recordId, r2.id);
});

// 11. 窗口外但持有的道具：起点前 / 终点后持有汇总，不产生收支
test('责任单：窗口内无交接但仍持有 -> 计入起点前与终点后持有', () => {
  // 剑：张三第 1 分领出，第 10 分才交出；窗口 3..6 内无交接
  const data = mkData(['剑'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 10, '张三', '李四'),
  ]);
  const r = personHandovers(data, '张三', 3, 6);
  assert.deepStrictEqual(r.events, []);
  assert.deepStrictEqual(names(r.heldBefore), ['剑']);
  assert.strictEqual(r.heldBefore[0].sinceMinute, 1);
  assert.deepStrictEqual(names(r.heldAfter), ['剑']);
  assert.strictEqual(r.heldAfter[0].sinceMinute, 1);
});

// 12. 该人在时间窗内完全不相关：空明细、空持有
test('责任单：无关人员 -> 空结果且不产生无法判定', () => {
  const data = mkData(['剑'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
  ]);
  const r = personHandovers(data, '路人甲', 0, 9);
  assert.deepStrictEqual(r.events, []);
  assert.deepStrictEqual(r.heldBefore, []);
  assert.deepStrictEqual(r.heldAfter, []);
  // 与该人无关的道具即使链完整，也不单列为无法判定（无冲突）
  assert.deepStrictEqual(r.undetermined, []);
});

// 13. 该人无关但另一件道具冲突：冲突道具仍须单列
test('责任单：无关人员查询时其他道具冲突仍单列无法判定', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p1', 1, WAREHOUSE, '李四'),
    rec('p1', 5, '李四', '王五'),
    rec('p1', 5, '李四', '赵六'),
  ]);
  const r = personHandovers(data, '张三', 0, 9);
  // 张三本人的剑收支正常
  assert.deepStrictEqual(eventTypes(r), [`1:${EVENT.RECEIVE}:剑`]);
  // 扇的冲突与张三无关，但窗口内链冲突 -> 仍单列为无法判定
  assert.deepStrictEqual(names(r.undetermined), ['扇']);
  assert.strictEqual(r.undetermined[0].conflictMinute, 5);
});

// 14. 收支次序跨道具按分钟、同分钟按道具名与链接续次序
test('责任单：跨道具按分钟排序，同分钟先接收后交出按接续次序', () => {
  // 剑：第 2 分领出给张三；第 3 分钟 张三→李四→王五（链式）；扇：第 3 分钟 仓库→李四
  const data = mkData(['剑', '扇'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 3, '李四', '王五'),
    rec('p1', 3, WAREHOUSE, '李四'),
  ]);
  const r = personHandovers(data, '李四', 3, 3);
  // 第 3 分钟：先按道具名「剑」（接收、交出），再「扇」（接收）
  assert.deepStrictEqual(eventTypes(r), [
    `3:${EVENT.RECEIVE}:剑`,
    `3:${EVENT.GIVE}:剑`,
    `3:${EVENT.RECEIVE}:扇`,
  ]);
  assert.deepStrictEqual(r.events.map((e) => e.seq), [1, 2, 3]);
});

console.log(`\n全部 ${passed} 个人员交接责任单测试通过 ✔`);
