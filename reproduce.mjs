// Deterministic transport regression fixture, not a model quality evaluation.
// Only writes below this task folder. Both Pi children remain foreground.
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const task = dirname(fileURLToPath(import.meta.url));
const run = join(process.env.INTERCOM_EVIDENCE_DIR || join(task, 'evidence'), 'run-' + Date.now());
const agent = join(run, 'a');
const pkg = process.env.INTERCOM_PACKAGE || task;
await mkdir(agent, { recursive: true });
await mkdir(join(agent, 'intercom'), { recursive: true });
if (process.argv.some(arg => ['--queue-test', '--crash-test', '--tool-step'].includes(arg))) await writeFile(join(agent, 'intercom', 'config.json'), JSON.stringify({ headlessFollowUp: true }));
const receiverId = randomUUID();
const senderId = randomUUID();
const nonce = 'BUSY-NONCE-' + randomUUID();
const requests = [], children = [], outcomes = [];
const crashTest = process.argv.includes('--crash-test');
const toolStep = process.argv.includes('--tool-step');
const queueTest = process.argv.includes('--queue-test') || crashTest || toolStep;
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
for (const key of Object.keys(env)) if (/^PI_(INTERCOM|SUBAGENT|SUPERVISOR)/.test(key)) delete env[key];
let receiverResponse, senderQueueResponse, receiverCalls = 0;
let senderQueuedResolve;
const senderQueued = new Promise(resolve => { senderQueuedResolve = resolve; });
let readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
async function waitRegistered(id, present = true) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [join(pkg, 'cli.mjs'), 'list', '--json'], { env, timeout: 4000 });
      const roster = JSON.parse(stdout);
      if (roster.sessions?.some(s => s.id === id) === present) return;
    } catch (error) {
      if (!/ENOENT|ECONNREFUSED/.test(error.stdout || '')) throw error;
    }
  }
  throw Error('Receiver did not register within 15 seconds');
}
function answer(res, model, delta, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = { id: randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model,
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
function tool(res, model, action, suffix) {
  answer(res, model, { tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
    function: { name: 'intercom', arguments: JSON.stringify({ action, to: receiverId, message: nonce + suffix, timeoutMs: 8000 }) } }] }, 'tool_calls');
}
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    await writeFile(join(run, 'requests.json'), JSON.stringify(requests, null, 2));
    if (body.model === 'receiver') {
      receiverCalls++;
      if (receiverCalls === 1 && toolStep) {
        answer(res, body.model, { tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
          function: { name: 'fixture_step', arguments: '{}' } }] }, 'tool_calls');
        const until = Date.now() + 15000;
        while (!existsSync(join(run, 'step.started')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
        if (!existsSync(join(run, 'step.started'))) throw Error('Original child step did not start');
        readyResolve();
      } else if (receiverCalls === 1) { receiverResponse = res; readyResolve(); }
      else answer(res, body.model, { content: toolStep && receiverCalls === 2 ? 'ORIGINAL CHILD STEP COMPLETE' : 'RECEIVER CONTINUATION' });
    } else {
      const results = body.messages.filter(m => m.role === 'tool');
      if (results.length === 0) tool(res, body.model, 'send', '-send');
      else if (results.length === 1 && crashTest) { senderQueueResponse = res; senderQueuedResolve(); }
      else if (results.length === 1 && !queueTest) tool(res, body.model, 'ask', '-ask');
      else answer(res, body.model, { content: 'SENDER COMPLETE' });
    }
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl, apiKey: 'local-fixture-not-a-secret',
  models: ['receiver','sender'].map(id => ({ id, name: id, reasoning: false, input: ['text'],
    contextWindow: 32000, maxTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))
} } }, null, 2));
if (toolStep) {
  const childPath = join(run, 'original-step.mjs');
  await writeFile(childPath, `import {existsSync,writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],'started'); const until=Date.now()+30000; while(!existsSync(process.argv[3]) && Date.now()<until) await new Promise(r=>setTimeout(r,10)); if(!existsSync(process.argv[3]))process.exit(2); writeFileSync(process.argv[4],'done');`);
  const childArgs = [childPath, join(run, 'step.started'), join(run, 'step.release'), join(run, 'step.done')];
  await writeFile(join(agent, 'fixture-step.ts'), `import {Type} from 'typebox'; import {spawn} from 'node:child_process'; export default pi=>pi.registerTool({name:'fixture_step',description:'Run an original child step until the test releases it',parameters:Type.Object({}),async execute(_id,_args,signal){await new Promise((resolve,reject)=>{const c=spawn(${JSON.stringify(process.execPath)},${JSON.stringify(childArgs)},{signal,stdio:'ignore'});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(Error('original child exit '+code)));});return {content:[{type:'text',text:'original child done'}],details:{done:true}};}});`);
}
function launch(role, id) {
  const args = ['--no-extensions', '-e', join(pkg, 'index.ts'), '--no-mcp', '--no-context-files',
    '--no-skills', '--no-prompt-templates', '--no-themes', '--offline',
    '--session-id', id, '--session-dir', join(run, 'sessions'), '--model', 'fixture/' + role,
    ...(toolStep && role === 'receiver' ? ['-e', join(agent, 'fixture-step.ts')] : []),
    '--thinking', 'off', '--tools', toolStep && role === 'receiver' ? 'intercom,fixture_step' : 'intercom', '--system-prompt', 'Scripted transport fixture.',
    '--print', 'Run the scripted transport fixture.'];
  const child = spawn(process.env.PI_BOLT_BINARY || 'pi-bolt', args, { cwd: task, env, stdio: ['ignore','pipe','pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const done = once(child, 'exit').then(async ([code, signal]) => {
    await writeFile(join(run, role + '.stdout'), stdout);
    await writeFile(join(run, role + '.stderr'), stderr);
    outcomes.push({ role, code, signal });
    return code;
  });
  return { child, done, args };
}
const deadline = setTimeout(() => {
  console.error('Fixture deadline exceeded');
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  server.closeAllConnections();
}, 45000);
try {
  const receiver = launch('receiver', receiverId);
  await Promise.race([ready, receiver.done.then(code => { throw Error('Receiver exited before ready: ' + code); })]);
  await waitRegistered(receiverId);
  const sender = launch('sender', senderId);
  if (crashTest) {
    await senderQueued;
    receiver.child.kill('SIGKILL');
    await receiver.done;
    await waitRegistered(receiverId, false);
    tool(senderQueueResponse, 'sender', 'status', '-status');
  }
  assert.equal(await sender.done, 0, 'sender must complete');
  const senderRequests = requests.filter(r => r.model === 'sender');
  const toolResults = senderRequests.at(-1).messages.filter(m => m.role === 'tool');
  assert.equal(toolResults.length, queueTest && !crashTest ? 1 : 2, 'real Pi sender must execute expected tools');
  if (queueTest) {
    assert.match(JSON.stringify(toolResults[0]), /queued/);
    assert.match(JSON.stringify(toolResults[0]), /not yet confirmed/);
  }
  assert.match(JSON.stringify(toolResults[0]), /Message sent|delivered|socket_delivered|queued/);
  if (!queueTest) assert.match(JSON.stringify(toolResults[1]), /non-interactive mode.*cannot respond/);
  if (crashTest) {
    assert.match(JSON.stringify(toolResults[1]), /expired/);
    assert.match(JSON.stringify(toolResults[1]), /receiver disconnected/);
  } else {
    if (toolStep) {
      assert.equal(existsSync(join(run, 'step.done')), false, 'original child still running during parent send');
      await writeFile(join(run, 'step.release'), 'release');
    } else answer(receiverResponse, 'receiver', { content: 'RECEIVER ORIGINAL TURN COMPLETE' });
    assert.equal(await receiver.done, 0, 'receiver must finish normally');
    if (toolStep) assert.equal(existsSync(join(run, 'step.done')), true, 'original child must survive and complete');
  }
  const receiverRequests = requests.filter(r => r.model === 'receiver');
  const transcriptFiles = await promisify(execFile)('fd', ['--type','f','.',join(run,'sessions')]);
  const transcripts = [];
  let senderTranscript;
  for (const file of transcriptFiles.stdout.trim().split('\n').filter(Boolean)) {
    const content = await readFile(file, 'utf8');
    if (JSON.parse(content.split('\n')[0]).id === receiverId) transcripts.push(content);
    if (JSON.parse(content.split('\n')[0]).id === senderId) senderTranscript = content;
  }
  assert.equal(transcripts.length, 1, 'must identify actual receiver transcript');
  if (queueTest) {
    const sentResult = senderTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.message?.role === 'toolResult' && e.message.toolName === 'intercom').message;
    assert.equal(sentResult.details.delivered, false, 'queued must not claim delivered');
    assert.equal(sentResult.details.accepted, true);
    assert.equal(sentResult.details.injected, false);
  }
  const sawNonce = JSON.stringify(receiverRequests).includes(nonce);
  const persistedNonce = transcripts[0].includes(nonce);
  const summary = { run, receiverId, senderId, nonce, package: pkg, baseUrl,
    senderToolResults: toolResults, receiverProviderCalls: receiverRequests.length,
    receiverSawNonce: sawNonce, receiverPersistedNonce: persistedNonce, outcomes,
    receiverArgs: receiver.args, senderArgs: sender.args };
  await writeFile(join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(process.env.INTERCOM_EVIDENCE_DIR || join(task, 'evidence'), 'latest-run.txt'), run + '\n');
  console.log(JSON.stringify(summary, null, 2));
  // Default is the red regression assertion. --expect-drop verifies the known broken baseline.
  if (crashTest) {
    assert.equal(sawNonce, false);
    assert.equal(persistedNonce, false);
    assert.equal(receiverRequests.length, 1);
    console.log('CRASH TEST PASS: queued status did not claim delivery; receiver crash reported expired/unconfirmed, with no nonce injection.');
  } else if (process.argv.includes('--expect-drop')) {
    assert.equal(sawNonce, false); assert.equal(persistedNonce, false);
    console.log('REPRODUCED: send reports success; ask gets canned rejection; receiver never sees or persists either nonce.');
  } else {
    assert.equal(sawNonce, true, 'DELIVERY BUG: broker accepted the message, but the receiver model never saw it');
    assert.equal(persistedNonce, true, 'message must persist in real session history');
    assert.equal(receiverRequests.length, toolStep ? 3 : 2, 'one continuation after the original request/tool run');
    assert.equal(JSON.stringify(receiverRequests[0]).includes(nonce), false, 'original request must not contain future messages');
    if (toolStep) assert.equal(JSON.stringify(receiverRequests[1]).includes(nonce), false, 'original child/tool run must finish before follow-up');
    assert.equal(JSON.stringify(receiverRequests.at(-1)).includes(nonce), true, 'continuation must consume the message');
    const injected = transcripts[0].split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === 'custom_message' && e.customType === 'intercom_message' && JSON.stringify(e).includes(nonce));
    assert.equal(injected.length, 1, 'one injection per message');
    console.log('QUEUE TEST PASS: original request completed, then one continuation consumed the nonce and persisted one intercom entry.');
  }
} finally {
  clearTimeout(deadline);
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  server.closeAllConnections();
  server.close();
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()));
  // Startup failures can leave an isolated broker alive; stop only this run's broker.
  try {
    const pid = Number(await readFile(join(agent, 'intercom', 'broker.pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (process.platform !== 'win32') {
        const brokerEnv = await readFile('/proc/' + pid + '/environ', 'utf8');
        if (!brokerEnv.split('\0').includes('PI_CODING_AGENT_DIR=' + agent)) throw Error('Refusing broker with unexpected agent directory');
      }
      process.kill(pid, 'SIGTERM');
    }
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}
