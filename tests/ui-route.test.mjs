// Route resolution over real uiautomator dumps.
//
// Both fixtures are VERBATIM subsets of real device captures (see each file's provenance comment),
// not hand-written examples, because the defect under test was invisible in the shapes I would have
// invented: it depends on the shipped shell emitting zero-sized nav labels, empty-text clickable tab
// targets, and NO clickable node for the active tab.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {isSized,boundsOf,textOf,nodesOf,screenOf,navBandOf,navTargetsOf,resolveRoute,centreOf} from '../scripts/lib/ui-route.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const fixture=(n)=>readFileSync(join(here,'fixtures','ui-route',n),'utf8');
const redesigned=fixture('redesigned-shell.xml');
const earlier=fixture('earlier-shell.xml');

const zeroSized=()=>nodesOf(redesigned).filter((a)=>textOf(a)!==''&&!isSized(a));

test('the redesigned-shell fixture really is the zero-sized-label shape', () => {
  // Guards the fixture: if the shell stops emitting this shape, the test must fail loudly rather
  // than let the module keep a workaround for something that no longer exists.
  const labels=zeroSized().map(textOf);
  assert.deepEqual(labels,['Home','Devices','Tasks','Activity','Settings']);
  for(const a of zeroSized())assert.deepEqual(boundsOf(a),{left:0,top:0,right:0,bottom:0});
});

test('a bare first-match label lookup selects a zero-bounds node, which is the original defect', () => {
  // Reproduces the replaced implementation exactly, so the regression is pinned rather than described.
  const bare=(source,text)=>[...source.matchAll(/<node\s+([^>]+)>/g)].find((m)=>m[1].includes('text="'+text+'"'));
  const chosen=bare(redesigned,'Home')[1];
  assert.equal(isSized(chosen),false);
  assert.deepEqual(centreOf(chosen),['0','0'],'the old lookup taps the top-left corner: a no-op');
});

test('no sized nav label exists on the shipped shell, so a size filter ALONE would leave nothing to tap', () => {
  const {height}=screenOf(redesigned);
  const sized=zeroSized(); // by definition zero-sized, so the label strategy cannot use them
  assert.equal(sized.length,5);
  // The label strategy must therefore find nothing in the band, and must not crash or invent a node.
  const route=resolveRoute(redesigned,{labels:['Home']});
  assert.equal(route.via,'nav-band','label strategy must not answer on this shell');
  assert.ok(isSized(route.attrs));
  // ...and the earlier shell still IS answered by the label strategy, so it is not simply dead code.
  assert.equal(resolveRoute(earlier,{labels:['Home']}).via,'label');
});

test('the active tab has no clickable node, so clickable ordinal alone is unstable', () => {
  // Measured, not assumed: the Devices page is active here, so only four of the five tabs are clickable.
  const band=navBandOf(redesigned);
  assert.equal(band.length,4,'the active tab contributes no clickable node');
  const targets=navTargetsOf(redesigned);
  assert.equal(targets.length,5,'but all five labels are present, so the mapping is recoverable');
  const active=targets.filter((t)=>t.active);
  assert.deepEqual(active.map((t)=>t.label),['Devices'],'the active tab is the one with no target');
  // This is the hazard an ordinal over clickables would hide: it would report Home as clickable and
  // silently mean a different tab once Home itself becomes active.
  for(const t of targets)assert.equal(t.active,t.attrs===null);
});

test('targets are paired to labels in document order, giving a page-independent index', () => {
  const targets=navTargetsOf(redesigned);
  assert.deepEqual(targets.map((t)=>t.label),['Home','Devices','Tasks','Activity','Settings']);
  assert.deepEqual(targets.map((t)=>t.attrs?boundsOf(t.attrs).left:null),[0,null,440,660,880]);
});

test('resolveRoute reaches Home from the Devices page via the paired target', () => {
  const route=resolveRoute(redesigned,{labels:['Home']});
  assert.ok(route);
  assert.equal(route.via,'nav-band');
  assert.equal(route.label,'Home');
  assert.deepEqual(route.centre,['100','2199']);
  const screen=screenOf(redesigned);
  assert.ok(+route.centre[0]>0&&+route.centre[0]<screen.width);
  assert.ok(+route.centre[1]>0&&+route.centre[1]<screen.height,'must be a real on-screen point');
});

test('the nav band excludes page content that happens to be clickable', () => {
  const screen=screenOf(redesigned);
  for(const n of navBandOf(redesigned))assert.ok(n.bounds.top>=screen.height*0.85);
  // The sized content card at [56,451][1024,1003] is clickable and must NOT be read as a tab.
  assert.ok(navBandOf(redesigned).every((n)=>n.bounds.top>=2000));
});

test('a sized heading is not mistaken for a nav target', () => {
  // `text="Devices"` occurs twice in the real capture: a sized heading and a zero-sized nav label.
  const occurrences=nodesOf(redesigned).filter((a)=>textOf(a)==='Devices');
  assert.equal(occurrences.length,2,'fixture should carry both the heading and the nav label');
  const heading=occurrences.find(isSized);
  assert.ok(heading,'the heading is the sized one');
  assert.ok(boundsOf(heading).top<1000,'the sized Devices node is page content');
  // Even asking for "Devices" directly must not return the heading: it is outside the nav band.
  const route=resolveRoute(redesigned,{labels:['Devices']});
  assert.ok(route===null||boundsOf(route.attrs).top>=2000,'must never tap page content as navigation');
});

test('resolveRoute prefers a sized label inside the band, preserving the earlier shell', () => {
  const route=resolveRoute(earlier,{tabIndex:0});
  assert.ok(route);
  assert.equal(route.via,'label');
  const b=route.bounds;
  assert.ok(b.right>b.left&&b.bottom>b.top);
  assert.deepEqual(route.centre,[String((b.left+b.right)>>1),String((b.top+b.bottom)>>1)]);
});

test('the two shells are distinguished rather than one being assumed', () => {
  assert.equal(resolveRoute(redesigned,{labels:['Home']}).via,'nav-band');
  assert.equal(resolveRoute(earlier,{labels:['Home']}).via,'label');
});

test('an unresolvable tree returns null rather than a zero-bounds node', () => {
  const noNav='<?xml version="1.0"?><hierarchy bounds="[0,0][1080,2400]"><node text="Home" class="android.widget.TextView" clickable="false" bounds="[0,0][0,0]" /></hierarchy>';
  assert.equal(resolveRoute(noNav,{labels:['Home']}),null,'must be a loud null, not a tap on (0,0)');
});

// The pilots can only be exercised end to end with a device attached, so the precondition that broke
// a real run is guarded statically. It is worth guarding because it is invisible in review and only
// fails at RUNTIME on a clean tree, at the very end of a multi-minute dual-device pipeline.
test('the task pilot creates its evidence directory before writing into it', () => {
  const src=readFileSync(join(here,'..','scripts','device-task-pilot.mjs'),'utf8');
  const mkdir=src.indexOf("mkdirSync('.runtime/evidence/v0.2'");
  const write=src.indexOf("writeFileSync('.runtime/evidence/v0.2/task-regression.json'");
  assert.ok(write>-1,'the pilot is expected to write task-regression.json');
  assert.ok(mkdir>-1,'the pilot must create .runtime/evidence/v0.2; without it a clean tree hits ENOENT');
  assert.ok(mkdir<write,'the directory must be created BEFORE the write, and ideally before the pipeline');
  // And it must happen before the run proper begins, so a missing directory fails fast rather than
  // after the whole dual-device pipeline has already been spent. Anchored on the first snapshot,
  // NOT on the first `cmd('shell',...)` - the APK integrity checks legitimately use that earlier,
  // and asserting against it was my own mistake when this guard was first written.
  const pipelineStart=src.indexOf('await snapshot()');
  assert.ok(pipelineStart>-1,'expected the pilot to take a city snapshot');
  assert.ok(mkdir<pipelineStart,'fail fast: create the directory before the pipeline starts');
});

 test("task pilot imports a usable sized nodeByLabel selector",async()=>{const {nodeByLabel}=await import("../scripts/lib/ui-route.mjs");assert.equal(typeof nodeByLabel,"function");const xml=`<node text="Run Test Task" bounds="[0,0][0,0]"/><node text="Run Test Task" bounds="[1,2][11,12]"/>`;assert.deepEqual(centreOf(nodeByLabel(xml,["Run Test Task"])),["6","7"]);assert.equal(nodeByLabel(xml,["Missing"]),null);});
