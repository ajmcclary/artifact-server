import type {BrowserFixture} from "./browser-fixture.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

/**
 * A page adapter written to the pageVersion 1 contract. Behaviors: honest
 * (restores and confirms), silent (never answers a restore), liar (confirms a
 * different scenario), no-adapter (never says hello), and overlapping (renders
 * a restore over several frames and ends one still running when the next
 * arrives with reason "timeout", as Design's pageVersion 1 adapter does), and
 * late (says hello four seconds after its document loaded).
 */
const adapterScript = `
(function () {
  var labels = {"1": "Library", "5": "Validation", "6": "Logic"};
  var behavior = document.documentElement.getAttribute("data-fixture-behavior");
  var current = "1";
  var root = document.getElementById("root");
  function render() {
    root.setAttribute("data-review-scenario", current);
    if (current === "5") {
      root.innerHTML = '<section data-review-region="inspector.validation"><h2>Validation</h2>' +
        '<label data-review-region="inspector.validation.min-length">Minimum length <input value="3"></label></section>' +
        '<p data-review-region="duplicate.note">First note</p><p data-review-region="duplicate.note">Second note</p>';
    } else {
      root.innerHTML = '<section data-review-region="screen"><h2>' + labels[current] + '</h2>' +
        '<button id="go-logic" type="button">Open Logic</button></section>';
      document.getElementById("go-logic").onclick = function () { setScenario("6", null); };
    }
  }
  function state() {
    return {
      direction: getComputedStyle(document.documentElement).direction === "rtl" ? "rtl" : "ltr",
      locale: document.documentElement.lang || null,
      pageVersion: 1,
      props: {scenario: current},
      scenarioId: root.getAttribute("data-review-scenario"),
      theme: "light",
      viewport: {height: innerHeight, width: innerWidth}
    };
  }
  function post(message) { parent.postMessage(message, "*"); }
  function afterPaint(callback) { requestAnimationFrame(function () { requestAnimationFrame(callback); }); }
  var pendingRestore = null;
  function slowRestore(id, requestId) {
    if (pendingRestore !== null) {
      clearTimeout(pendingRestore.timer);
      post({ok: false, reason: "timeout", requestId: pendingRestore.requestId, state: state(), type: "as-page-restored"});
    }
    var job = {requestId: requestId, timer: 0};
    pendingRestore = job;
    job.timer = setTimeout(function () {
      if (pendingRestore !== job) return;
      pendingRestore = null;
      setScenario(id, requestId);
    }, 150);
  }
  function setScenario(id, requestId) {
    current = labels[id] ? id : current;
    render();
    afterPaint(function () {
      // Like the specified adapter, report every scenario change, then answer the restore.
      post({requestId: null, state: state(), type: "as-page-state"});
      if (requestId !== null) post({ok: true, requestId: requestId, state: state(), type: "as-page-restored"});
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var m = event.data;
    if (!m || typeof m.type !== "string") return;
    if (m.type === "as-page-restore") {
      if (behavior === "silent") return;
      if (behavior === "overlapping") { slowRestore(String(m.props.scenario), m.requestId); return; }
      setScenario(behavior === "liar" ? "6" : String(m.props.scenario), m.requestId);
    } else if (m.type === "as-page-capture") {
      post({requestId: m.requestId, state: state(), type: "as-page-state"});
    } else if (m.type === "as-page-region-at") {
      var element = null;
      try { element = document.querySelector(m.selector); } catch (error) { element = null; }
      var region = element && element.closest("[data-review-region]");
      if (!region) { post({reason: "none", region: null, requestId: m.requestId, type: "as-page-region"}); return; }
      var id = region.getAttribute("data-review-region");
      var count = document.querySelectorAll('[data-review-region="' + id + '"]').length;
      post(count === 1
        ? {region: {label: (region.textContent || "").trim().slice(0, 256), regionId: id, tagName: region.tagName.toLowerCase()}, requestId: m.requestId, type: "as-page-region"}
        : {reason: "ambiguous", region: null, requestId: m.requestId, type: "as-page-region"});
    } else if (m.type === "as-page-region-find") {
      post({requestId: m.requestId, type: "as-page-regions", results: m.regionIds.map(function (regionId) {
        var found = document.querySelectorAll('[data-review-region="' + regionId + '"]');
        return {count: found.length, regionId: regionId, tagName: found.length === 1 ? found[0].tagName.toLowerCase() : null};
      })});
    }
  });
  render();
  var hello = {capabilities: ["capture", "regions", "restore"], pageVersion: 1, type: "as-page-hello"};
  if (behavior === "late") setTimeout(function () { post(hello); }, 4000);
  else if (behavior !== "no-adapter") post(hello);
})();
`;

const encoder = new TextEncoder();

function page(path: string, behavior: string, runtime: "external" | "inline" = "inline"): TestSiteFile {
  const script = runtime === "inline" ? `<script>${adapterScript}</script>` : `<script src="cold-runtime.js"></script>`;
  return {
    bytes: encoder.encode(`<!doctype html><html lang="en" data-fixture-behavior="${behavior}"><head><meta charset="utf-8"><title>${behavior}</title></head><body><main id="root"></main>${script}</body></html>`),
    mediaType: "text/html; charset=utf-8",
    path,
  };
}

function view(viewId: string, path: string) {
  return {
    defaultScenarioId: "1",
    label: `Fixture ${viewId}`,
    parameters: [],
    path,
    scenarios: [
      {label: "Library", props: {scenario: "1"}, scenarioId: "1"},
      {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
      {label: "Logic", props: {scenario: "6"}, scenarioId: "6"},
    ],
    sourceRef: {line: 7, path: `fixture/${path}`},
    viewId,
  };
}

export async function publishScenarioFixture(fixture: BrowserFixture, key: string): Promise<PublishResponse> {
  const files: TestSiteFile[] = [
    page("honest.html", "honest"),
    page("silent.html", "silent"),
    page("liar.html", "liar"),
    page("no-adapter.html", "no-adapter"),
    page("overlapping.html", "overlapping"),
    page("late.html", "late"),
    // A Claude Design artboard that loads its runtime from a file, as Forms loads React.
    page("cold.dc.html", "honest", "external"),
    {bytes: encoder.encode(adapterScript), mediaType: "text/javascript; charset=utf-8", path: "cold-runtime.js"},
    {
      bytes: encoder.encode(JSON.stringify({
        format: "artifact-server.views",
        version: 1,
        views: [
          view("fixture/honest", "honest.html"),
          view("fixture/silent", "silent.html"),
          view("fixture/liar", "liar.html"),
          view("fixture/no-adapter", "no-adapter.html"),
          view("fixture/overlapping", "overlapping.html"),
          view("fixture/late", "late.html"),
          view("fixture/cold", "cold.dc.html"),
        ],
      })),
      mediaType: "application/json",
      path: "artifactserver.views.json",
    },
  ];
  const upload = await createStagedUpload(fixture.server, fixture.installation, "honest.html", files);
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  return (await commitStagedUpload(fixture.installation, upload.body, `scenario-fixture-${key}`, {
    accessSetting: "account_required",
    kind: "new_artifact",
    name: "Scenario fixture",
    tags: [],
  })).body;
}
