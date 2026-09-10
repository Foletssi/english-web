import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { sealPlaybackTicket, openPlaybackTicket } from '../functions/_lib/playback-ticket.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const env={PLAYBACK_TICKET_KEY:Buffer.alloc(32,7).toString('base64url')};
const now=Math.floor(Date.now()/1000);
const payload={aud:'eastudy-playback',sub:'student-1',job:'00000000-0000-4000-8000-000000000001',prefix:'videos/source/processed/job/runs/run/',exp:now+300};
const ticket=await sealPlaybackTicket(payload,env);
assert.equal(ticket.split('.').length,2);
assert.deepEqual(await openPlaybackTicket(ticket,env),payload);
await assert.rejects(()=>openPlaybackTicket(ticket.slice(0,-1)+(ticket.endsWith('A')?'B':'A'),env));
await assert.rejects(async()=>openPlaybackTicket(await sealPlaybackTicket({...payload,exp:now-1},env),env),/EXPIRED/);
console.log('Playback ticket contract: 4 checks passed.');
