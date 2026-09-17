(function (global) {
  'use strict';
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  // Replay only edits made while the reservation was in flight over its authoritative snapshot.
  function mergeEdits(before, current, remote) {
    if (equal(before, current)) return remote;
    if (Array.isArray(before) && Array.isArray(current) && Array.isArray(remote) &&
        [...before, ...current, ...remote].every(row => object(row) && row.id != null)) {
      const b = new Map(before.map(row => [String(row.id), row]));
      const c = new Map(current.map(row => [String(row.id), row]));
      const r = new Map(remote.map(row => [String(row.id), row]));
      for (const [id, row] of b) {
        if (!c.has(id)) r.delete(id);
        else if (r.has(id) && !equal(row, c.get(id))) r.set(id, mergeEdits(row, c.get(id), r.get(id)));
      }
      for (const [id, row] of c) if (!b.has(id)) r.set(id, row);
      return [...r.values()];
    }
    if (object(before) && object(current) && object(remote)) {
      const result = {...remote};
      for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
        if (equal(before[key], current[key])) continue;
        if (!(key in current)) delete result[key];
        else result[key] = mergeEdits(before[key], current[key], remote[key]);
      }
      return result;
    }
    return current;
  }
  async function reserve(input, context) {
    let before = context.snapshot(), hasLocalEdits = false;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await context.cloud.reserveLocalProcessingJob(input, context.revision());
        if (result.error) {
          if (![result.error.code, result.error.message].some(value => String(value || '').includes('CONTENT_REVISION_CONFLICT')) || attempt === 2) throw result.error;
          const remote = await context.cloud.pullAdmin();
          if (remote.error) throw remote.error;
          if (!remote.snapshot || !Number.isSafeInteger(remote.revision) || remote.revision < context.revision()) throw new Error('LOCAL_RESERVATION_RESPONSE_INVALID');
          const snapshot = mergeEdits(before, context.snapshot(), remote.snapshot);
          context.importMutation({data: {snapshot, revision: remote.revision}});
          hasLocalEdits ||= !equal(snapshot, remote.snapshot);
          // Keep the server snapshot as the base until all outstanding edits are saved.
          before = remote.snapshot;
          continue;
        }
        if (!result.data?.snapshot || !result.data?.job?.id || !result.data?.intakeTicket ||
            !result.data?.inputSource?.sourceId) throw new Error('LOCAL_RESERVATION_RESPONSE_INVALID');
        const snapshot = mergeEdits(before, context.snapshot(), result.data.snapshot);
        context.importMutation({...result, data: {...result.data, snapshot}});
        hasLocalEdits ||= !equal(snapshot, result.data.snapshot);
        return result;
      }
    } finally {
      // Scheduling (not awaiting) avoids waiting on this same content-write queue.
      if (hasLocalEdits) context.saveLater();
    }
  }
  global.EastudyLocalReservation = Object.freeze({reserve, mergeEdits});
})(window);
