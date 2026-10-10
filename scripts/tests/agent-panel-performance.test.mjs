import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
import vm from 'node:vm';

// Execute the actual mount controller (not a duplicate implementation). React's
// boundary is instrumented to count work deterministically without a shared
// build/server, timing thresholds, or relying on DOM mutations as render counts.
const source = await readFile(new URL('../../apps/console/src/agents.tsx', import.meta.url), 'utf8');
const mountSource = stripTypeScriptTypes(source.slice(source.indexOf('export function mountAgents')).replace('export function', 'function'));
function harness() {
  const renders = [], roots = [], elements = [];
  const context = vm.createContext({
    Agents: function Agents() {},
    createElement(component, props) {const element = {component, props};elements.push(element);return element;},
    createRoot(element) {
      const root = {element, unmounts: 0, render(tree) {renders.push(tree);}, unmount() {this.unmounts++;}};
      roots.push(root);return root;
    },
  });
  vm.runInContext(mountSource, context, {filename: 'agents.tsx mount controller'});
  const callbacks = {request() {}, onSelect() {}, onRefresh() {}, onOpenBot() {}};
  return {view: context.mountAgents({}, callbacks), callbacks, roots, renders, elements};
}
const history = Array.from({length: 1000}, (_, index) => Object.freeze({
  id: `completed-${index}`, name: `Reviewer ${index}`, status: 'completed',
  parentSubagentId: index ? `completed-${index - 1}` : undefined,
  task: `Review ${index}: **retained Markdown-like task**\n\n\`\`\`js\nconst historical = ${index};\n\`\`\``,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T01:00:00Z',
}));
function model(revision = 0, extra = {}) {
  return {botId: 'bot-a', botName: 'Ada', agents: [...history, {id: 'active', name: 'Active reviewer', status: 'running', task: 'Live task', updatedAt: String(revision)}],
    namedAgents: [], delegations: [], loading: false, selectedAgentId: null, revision, events: [], runs: [], collaborationEvents: [], ...extra};
}

test('1000 completed agents + 1000 live updates: closed panel performs zero root creation/render/element work', () => {
  const h = harness();
  let latest;
  for (let revision = 0; revision < 1000; revision++) h.view.update(latest = model(revision));
  assert.equal(h.roots.length, 0);
  assert.equal(h.renders.length, 0);
  assert.equal(h.elements.length, 0, 'even React element construction is skipped while closed');
  h.view.setActive(false);
  assert.equal(h.roots.length, 0, 'layout refresh while closed is inert');
  h.view.setActive(true);
  assert.equal(h.roots.length, 1, 'first opening lazily creates the React root');
  assert.equal(h.renders.length, 1, 'one render of the newest state, not replaying 1000 cached snapshots');
  assert.equal(h.renders[0].props.model, latest);
  assert.equal(h.renders[0].props.model.revision, 999);
  assert.equal(h.renders[0].props.model.agents.length, 1001, 'all history remains available');
  for (let index = 0; index < 1000; index++) assert.equal(h.renders[0].props.model.agents[index], history[index]);
  h.view.setActive(true);h.view.update(latest);
  assert.equal(h.renders.length, 1, 'repeated layout/model identity does not rerender');
});

test('after opening, hidden active updates never render; latest direct-route selection survives reopening', () => {
  const h = harness();
  h.view.setActive(true);
  assert.equal(h.roots.length, 0, 'opening without a model waits for the latest data');
  h.view.update(model());
  const firstRoot = h.roots[0];
  h.view.setActive(false);
  const before = h.renders.length;
  let latest;
  for (let revision = 1; revision <= 500; revision++) h.view.update(latest = model(revision, {selectedAgentId: 'completed-987'}));
  assert.equal(h.renders.length, before, 'zero hidden root.render calls even after previously mounted');
  assert.equal(firstRoot.unmounts, 0, 'hiding does not discard composer drafts/scroll');
  h.view.setActive(true);
  assert.equal(h.roots.length, 1, 'opened tree is reused');
  assert.equal(h.renders.length, before + 1);
  assert.equal(h.renders.at(-1).props.model, latest);
  assert.equal(h.renders.at(-1).props.model.selectedAgentId, 'completed-987');
  assert.equal(h.renders.at(-1).props.callbacks, h.callbacks);
  h.view.update(model(501, {selectedAgentId: 'active'}));
  assert.equal(h.renders.length, before + 2, 'visible updates continue to reach the actual panel');
  assert.equal(h.renders.at(-1).props.model.selectedAgentId, 'active');
});

test('selecting a different bot while hidden publishes only its latest model with a new state-isolation key', () => {
  const h = harness();
  h.view.setActive(true);
  const oldBot = model(10, {selectedAgentId: 'completed-10'});
  h.view.update(oldBot);
  const oldKey = h.renders.at(-1).props.key;
  h.view.setActive(false);
  const before = h.renders.length;
  h.view.update(model(0, {botId: 'bot-b', botName: 'Linus', agents: [], selectedAgentId: null}));
  const selected = {id: 'bot-b-agent', name: 'New bot reviewer', status: 'running'};
  const latest = model(1, {botId: 'bot-b', botName: 'Linus', agents: [selected], selectedAgentId: selected.id});
  h.view.update(latest);
  assert.equal(h.renders.length, before, 'bot changes also publish nothing while hidden');
  h.view.setActive(true);
  assert.equal(h.renders.length, before + 1, 'reopening publishes only the latest other-bot snapshot');
  assert.equal(h.renders.at(-1).props.model, latest);
  assert.equal(h.renders.at(-1).props.model.selectedAgentId, 'bot-b-agent');
  assert.equal(h.renders.at(-1).props.key, 'bot-b');
  assert.notEqual(h.renders.at(-1).props.key, oldKey, 'React replaces the keyed Agents tree; old conversation draft state cannot carry across bots');
  assert.equal(h.renders.at(-1).props.model.agents.includes(history[10]), false);
});

test('bot/session clear discards old cached selection and unmounts once, without hidden root.render(null)', () => {
  const h = harness();
  h.view.update(model(10, {selectedAgentId: 'completed-10'}));
  h.view.setActive(true);h.view.setActive(false);
  const root = h.roots[0], before = h.renders.length;
  h.view.clear();h.view.clear();
  assert.equal(root.unmounts, 1);
  assert.equal(h.renders.length, before);
  h.view.setActive(true);
  assert.equal(h.roots.length, 1, 'no stale model is mounted after clear');
  const other = model(0, {botId: 'bot-b', botName: 'Linus', agents: [], selectedAgentId: null});
  h.view.update(other);
  assert.equal(h.roots.length, 2);
  assert.equal(h.renders.at(-1).props.key, 'bot-b');
  assert.equal(h.renders.at(-1).props.model, other);
});

test('management previews are memoized, parent lookups are indexed, and historical Markdown is not mounted in the list', () => {
  const previews = source.slice(source.indexOf('const AgentCard'), source.indexOf('function Agents({model'));
  assert.match(previews, /const AgentCard = memo\(/);
  assert.match(previews, /const AgentsOverview = memo\(/);
  assert.match(previews, /useMemo\(\(\) => new Map\(agents\.map/);
  assert.match(previews, /parentNames\.get\(agent\.parentSubagentId\)/);
  assert.doesNotMatch(previews, /\.find\(/, 'no quadratic per-card parent scan');
  assert.doesNotMatch(previews, /MessageResponse|AgentConversation/, 'full conversation/Markdown only mounts upon selection');
  assert.match(source, /if \(selected\) return <AgentConversation/);
  assert.match(previews, /sameItems\(previous\.agents, next\.agents\)/, 'event-only updates bail out of the overview');
});
