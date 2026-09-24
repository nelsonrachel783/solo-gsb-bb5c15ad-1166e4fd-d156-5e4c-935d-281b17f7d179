'use strict';

/**
 * 人员交接责任单引擎（只读，生成即时结果，不改写交接记录）。
 *
 * 输入「人员 + 起止分钟（均含）」，对每件道具沿用核验引擎的同分钟唯一链规则重放：
 *
 * - heldBefore：窗口起点交接前（第 fromMinute 分钟的交接发生之前）该人持有的道具；
 * - events：窗口内（含起止分钟）该人按「实际接续顺序」逐次接收（RECEIVE）、
 *   交出（GIVE）的道具与对应记录；
 * - heldAfter：窗口终点交接后（第 toMinute 分钟全部交接完成后）该人持有的道具；
 * - undetermined：窗口前或窗口内交接链已冲突的道具，单列并标明冲突分钟，
 *   既不计入确定持有，也不计入收支明细；
 * - 重放只取 minute <= toMinute 的记录，因此窗口后的冲突不影响本次结果。
 */

const { WAREHOUSE, CONFLICT, sortRecords, replayPropRecords } = require('./verify');

/** 收支事项类型 */
const EVENT = {
  RECEIVE: 'RECEIVE', // 该人接收道具（记录的接收者 == 该人）
  GIVE: 'GIVE',       // 该人交出道具（记录的交出者 == 该人）
};

/** 无法判定道具的冲突发生阶段 */
const PHASE = {
  BEFORE: 'BEFORE',         // 冲突发生在窗口起点之前
  IN_WINDOW: 'IN_WINDOW',   // 冲突发生在窗口内（含起止分钟）
};

function conflictTypeText(type) {
  return type === CONFLICT.AMBIGUOUS
    ? '同一分钟多条可接续记录，交接链不唯一'
    : '剩余记录无法接续，交接链断裂';
}

/**
 * 链上该人最后一次成为持有人的分钟（窗口起点 / 终点持有件的「自持分钟」）。
 * 链为空（道具始终在仓库）时取 0。
 */
function becameHolderMinute(chain, person) {
  let since = 0;
  for (const rec of chain) {
    if (rec.to === person) since = rec.minute;
  }
  return since;
}

function buildUndetermined(prop, conflict, phase) {
  return {
    propId: prop.id,
    propName: prop.name,
    phase,
    conflictType: conflict.type,
    conflictTypeText: conflictTypeText(conflict.type),
    conflictMinute: conflict.minute,
    holder: conflict.holder,
    recordIds: conflict.records,
    reason: conflict.reason,
  };
}

/**
 * 生成一份人员交接责任单。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（与记录中的交出者 / 接收者精确匹配）
 * @param {number} fromMinute 起始分钟（含）
 * @param {number} toMinute 截止分钟（含）
 * @returns {{person, fromMinute, toMinute, warehouse, events, heldBefore, heldAfter, undetermined, summary}}
 */
function personHandovers(data, person, fromMinute, toMinute) {
  const props = data.props || [];
  const allRecords = sortRecords(data.records || []);

  const events = [];
  const heldBefore = [];
  const heldAfter = [];
  const undetermined = [];

  for (const prop of props) {
    const propRecords = allRecords.filter((r) => r.propId === prop.id);
    const beforeRecords = propRecords.filter((r) => r.minute < fromMinute);
    const windowRecords = propRecords.filter(
      (r) => r.minute >= fromMinute && r.minute <= toMinute
    );

    // 1) 先重放窗口起点之前的记录，确定「起点交接前」的持有人
    const pre = replayPropRecords(beforeRecords);
    if (!pre.ok) {
      // 窗口前链已冲突：窗口内的去向同样无法判定，整件道具单列
      undetermined.push(buildUndetermined(prop, pre.conflict, PHASE.BEFORE));
      continue;
    }

    // 2) 再把窗口内（含起止分钟）的记录接续重放：得到终点交接后的持有人与实际接续链。
    //    两段本就各自有序且前一段分钟严格更小，拼接后仍是按分钟升序。
    const replay = replayPropRecords([...beforeRecords, ...windowRecords]);
    if (!replay.ok) {
      undetermined.push(buildUndetermined(prop, replay.conflict, PHASE.IN_WINDOW));
      continue;
    }

    if (pre.holder === person) {
      heldBefore.push({
        propId: prop.id,
        propName: prop.name,
        sinceMinute: becameHolderMinute(pre.chain, person),
      });
    }

    // 3) 收支明细只取窗口内的链上记录（idx 越过窗口前的部分）
    replay.chain.forEach((rec, idx) => {
      if (idx < pre.chain.length) return;
      if (rec.to === person) {
        events.push({
          type: EVENT.RECEIVE,
          propId: prop.id,
          propName: prop.name,
          minute: rec.minute,
          chainIndex: idx,
          counterparty: rec.from,
          recordId: rec.id,
          note: rec.note || '',
        });
      } else if (rec.from === person) {
        events.push({
          type: EVENT.GIVE,
          propId: prop.id,
          propName: prop.name,
          minute: rec.minute,
          chainIndex: idx,
          counterparty: rec.to,
          recordId: rec.id,
          note: rec.note || '',
        });
      }
    });

    if (replay.holder === person) {
      heldAfter.push({
        propId: prop.id,
        propName: prop.name,
        sinceMinute: becameHolderMinute(replay.chain, person),
      });
    }
  }

  // 按实际接续顺序跨道具汇总：分钟升序；同一分钟先按道具名称、再按链上的接续次序
  events.sort((a, b) =>
    a.minute - b.minute ||
    a.propName.localeCompare(b.propName, 'zh-Hans-CN') ||
    a.chainIndex - b.chainIndex ||
    String(a.recordId).localeCompare(String(b.recordId))
  );
  events.forEach((e, i) => { e.seq = i + 1; });

  const byName = (a, b) =>
    a.propName.localeCompare(b.propName, 'zh-Hans-CN') ||
    String(a.propId).localeCompare(String(b.propId));
  heldBefore.sort(byName);
  heldAfter.sort(byName);
  undetermined.sort((a, b) => a.conflictMinute - b.conflictMinute || byName(a, b));

  const involvedPropIds = new Set(events.map((e) => e.propId));
  const summary = {
    totalProps: props.length,
    involvedProps: involvedPropIds.size,
    receiveCount: events.filter((e) => e.type === EVENT.RECEIVE).length,
    giveCount: events.filter((e) => e.type === EVENT.GIVE).length,
    heldBeforeCount: heldBefore.length,
    heldAfterCount: heldAfter.length,
    undeterminedCount: undetermined.length,
  };

  return {
    person,
    fromMinute,
    toMinute,
    warehouse: WAREHOUSE,
    events,
    heldBefore,
    heldAfter,
    undetermined,
    summary,
  };
}

module.exports = { EVENT, PHASE, personHandovers };
