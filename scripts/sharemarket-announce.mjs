#!/usr/bin/env node
// Local cron command; authorization is rechecked on every run and send.
import {executeMarketAnnouncement} from '../src/src/features/sharemarket.js';
import {deliveryQueue} from '../src/src/delivery/queue.js';
const [jobId,slot]=process.argv.slice(2);
if(!jobId||!slot)throw new Error('Usage: sharemarket-announce.mjs REGISTERED_JOB_ID YYYY-MM-DD[THH:MM]');
const result=await executeMarketAnnouncement(jobId,slot,{queue:deliveryQueue()});
console.log(JSON.stringify(result));
if(!result.ok||result.state!=='accepted')process.exitCode=1;
