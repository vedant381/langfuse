# Observation Detail Aggregation

## Goal

Let users control the aggregation scope of observation detail views opened from
the events table or shown on a full trace page.

Supported scopes:

- **Observation**: show only the selected observation's details. Do not show a
  tree, timeline, graph, or trace-level aggregate metrics.
- **Trace**: preserve the current trace detail experience.
- **Session**: zoom out to all traces and observations in the selected
  observation's session. Aggregate metrics at the session level and add a
  synthetic session root to the tree, timeline, and graph.

The feature applies to:

- The v4 EventsTable observation drawer.
- The full trace detail page.

It does not initially apply to legacy drawers, annotation views, experiment
previews, or unrelated consumers of the trace detail components.

## Product Decisions

### URL State

Store the selected scope in a URL parameter:

```text
?aggregation=observation|trace|session
```

- Default to `trace` when the parameter is absent or invalid.
- Preserve the focused observation ID when switching scopes.
- Preserve the original trace ID and timestamp so switching back to trace scope
  does not require rediscovering the source trace.
- Use URL history consistently with existing observation and mobile-tab state.
- Shared links retain the aggregation scope.

### Scope Availability

- `Trace` is always available when trace detail data can be resolved.
- `Observation` is available only when an observation is selected.
- `Session` is available only when the current observation or trace has a
  non-null session ID.
- Disabled options explain why they are unavailable.
- If a URL requests an unavailable scope, fall back to `trace` and render the
  selector in a valid state.

### Large Sessions

- Apply a server-owned hard cap to session observations.
- Return the applied cap, total observation count, and truncation state from the
  server.
- Always include the focused observation, even if it lies outside the bounded
  chronological result.
- Clearly distinguish complete server-computed session metrics from a partial
  tree, timeline, or graph.
- If complete metrics cannot be computed, label them as partial rather than
  silently understating them.

## Implementation Strategy

Model and review the complete feature in Storybook before changing real pages,
drawers, URL hooks, private API hooks, routers, services, or repositories.

The order is deliberately:

1. Define client-safe contracts for the data the future APIs must deliver.
2. Split affected context/network components into connected adapters and pure
   views where required by the Storybook rules.
3. Document current behavior in stories before changing those pure views.
4. Extend the pure models and views for Observation, Trace, and Session and add
   stories for the new behavior.
5. Compose and review the complete fixture-backed feature in Storybook.
6. Integrate the reviewed components into connected page/drawer controllers.
7. Implement the already-defined API contracts last.

Defining an API means committing its client-safe request/response types,
semantics, limits, completeness rules, and fixtures. It does not mean adding a
tRPC procedure or ClickHouse query. Storybook fixtures must satisfy the exact
contract that the eventual API implements, so UI work cannot quietly depend on
data the backend will not provide.

## Architecture

### Aggregation Model

Define one shared client-side type near the trace feature:

```ts
type DetailAggregation = "observation" | "trace" | "session";
```

Add a small URL hook that parses, validates, and updates the aggregation query
parameter. URL ownership stays in connected drawer/page controllers rather than
in presentational components.

### Scope-Aware Controller

The current detail path is trace-specific:

```text
peek or page
  -> useTraceDetailData
  -> useEventsTraceData
  -> TraceDetailBody
  -> Trace
```

After Storybook signoff, add a scope-aware controller for the EventsTable
drawer and full trace page. It renders the same pure workspace used by the
feature-level stories:

```text
DetailAggregationController (connected, added after Storybook signoff)
  -> DetailAggregationWorkspace (pure)
     -> DetailAggregationSelector
     -> ObservationDetailContent
     -> TraceDetailContentView
     -> SessionDetailContentView
        -> SessionAggregateDetail
        -> hierarchy navigation slots
```

The controller owns:

- URL state.
- Query selection and query enablement.
- Loading, error, unavailable-scope, and not-found states.
- Adapting server responses into render models.
- Analytics.

Use a discriminated result type so each render branch receives only valid data:

```ts
type DetailScopeResult =
  | { aggregation: "observation"; observation: ObservationDetailViewModel }
  | {
      aggregation: "trace";
      trace: TraceDetailViewModel;
      truncatedAtObservations?: number;
    }
  | {
      aggregation: "session";
      session: SessionDetailViewModel;
      truncatedAtObservations?: number;
    };
```

Keep `useTraceDetailData` intact for existing consumers. Do not broaden all
trace detail surfaces as part of this feature.

### Query Behavior

- Observation scope fetches only the selected observation and the data needed
  by its detail view.
- Trace scope continues through `useTraceDetailData` and
  `useEventsTraceData`.
- Session scope uses a new session-detail endpoint.
- Do not run trace or session detail queries while Observation scope is active.
- Avoid retaining stale results from the previous scope during a switch.

## Observation Scope

Render the existing observation detail experience without mounting:

- `TraceDataProvider`.
- `TraceGraphDataProvider`.
- Trace tree or search navigation.
- Timeline.
- Graph.
- Trace-level aggregate detail.

The current `ObservationDetailView` owns context and network access, so split it
into:

- A connected `ObservationDetailView` wrapper.
- A pure `ObservationDetailContent` component receiving loaded data through
  typed props.

The pure component becomes the Storybook surface.

## Contracts First, APIs Last

Create client-safe contract modules before changing any UI. They must not
import tRPC, router outputs, React context, or server repositories. Storybook
fixtures and pure builders depend on these contracts; the eventual API
implementation must return them without introducing a second UI-specific
adapter shape.

Suggested ownership:

- `web/src/features/traces/types/detailAggregation.ts`
- `web/src/features/traces/types/sessionDetail.ts`
- `web/src/features/trace-graph-view/types.ts` for graph source/model contracts
- A colocated fixture module under the relevant story directory that uses
  `satisfies` against these contracts

### Detail Aggregation Contract

```ts
type DetailAggregation = "observation" | "trace" | "session";

type DetailSelectionTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "trace"; traceId: string }
  | {
      kind: "observation";
      traceId: string;
      observationId: string;
    };

type HierarchyNode =
  | SessionHierarchyNode
  | TraceHierarchyNode
  | ObservationHierarchyNode;
```

The discriminant, not `type === "TRACE"`, determines whether a node can be
prefetched, played back, scored, commented on, or loaded as an observation.
Structured entity references are the canonical behavioral identity. Selection
always carries the owning trace for an observation. A separate opaque,
collision-proof UI key encoder produces React, map, virtualization, and ELK
keys. Encoded UI keys are never treated as domain identity or sent to APIs.

Freeze props-only view contracts for all three scopes before stories are
written:

```ts
type ObservationDetailViewModel = {
  observation: PreparedObservationDetail;
  metrics: NormalizedDetailMetrics;
  scores: PreparedScore[];
  comments: PreparedCommentState;
};

type TraceDetailViewModel = {
  trace: PreparedTraceDetail;
  metrics: NormalizedDetailMetrics;
  observations: PreparedObservationSummary[];
  scores: PreparedScore[];
  completeness: DetailCompleteness;
};

type SessionDetailViewModel = {
  session: SessionDetailResponse["session"];
  hierarchy: HierarchyNode[];
  visualizationCompleteness: SessionDetailResponse["visualizationCompleteness"];
  metricCompleteness: SessionDetailResponse["metricCompleteness"];
};
```

These are frontend rendering contracts, not replacements for existing trace or
observation API outputs. Existing connected adapters prepare them from current
queries. Fixtures for Observation and Trace scopes satisfy these view contracts
just as Session fixtures satisfy the new API response contract.

### Session Detail Request

Define the future protected events request as:

```ts
type SessionDetailRequest = {
  projectId: string;
  sessionId: string;
  focusedObservation?: {
    traceId: string;
    observationId: string;
  };
};
```

The endpoint may later be exposed conceptually as
`events.bySessionId(SessionDetailRequest)`, but no procedure is added during
the Storybook phases.

### Session Detail Response

```ts
type SessionDetailResponse = {
  session: {
    id: string;
    projectId: string;
    startTime: Date;
    endTime: Date;
    isInFlight: boolean;
    traceCount: number;
    observationCount: number;
    usage: AggregateUsage;
    cost: AggregateCost;
    scores: SessionScore[];
  };
  traces: Array<{
    id: string;
    name: string | null;
    startTime: Date;
    endTime: Date;
    isInFlight: boolean;
    observationCount: number;
    usage: AggregateUsage;
    cost: AggregateCost;
    observations: SessionObservationSummary[];
  }>;
  focusedObservationDetail?: ObservationDetailViewModel;
  visualizationCompleteness: {
    complete: boolean;
    reasons: Array<"observation-limit" | "trace-limit">;
    returnedObservations: number;
    totalObservations: number;
    observationLimit: number;
    focusedObservationIncluded: boolean;
  };
  metricCompleteness: {
    complete: boolean;
    partialMetrics: string[];
  };
};
```

`SessionObservationSummary` carries at least its `traceId`, persisted
observation ID, parent ID, type, name, timestamps, level, usage, cost, and the
bounded score data needed by hierarchy renderers. It does not carry full I/O,
metadata, media, or every field needed by the observation detail view. The
optional focused detail payload contains the fully prepared selected
observation; selecting another row loads and caches that observation's full
detail separately. Parent IDs are only resolved within the owning trace.

Session and trace temporal bounds are separate from activity state:

- `startTime` is the earliest observation start.
- `endTime` is the latest `coalesce(observation.endTime,
observation.startTime)`.
- `isInFlight` is true when any queryable observation in that aggregate has no
  end time.

The response guarantees:

- Session ID and authoritative aggregate metadata.
- A bounded, deterministically ordered observation set grouped by trace.
- Explicit complete/partial semantics.
- Complete session-targeted scores and child scores for the bounded rendered
  traces and observations plus the focused observation.
- The focused observation even when it lies outside the normal capped window.
- Enough trace data to synthesize trace wrappers without another request.
- Complete aggregate metrics even when visualization rows are partial, or an
  explicit contract flag if that guarantee cannot be met.

Limits exist only to address measured performance constraints. Do not cap
session aggregates, exact counts, or session-targeted scores merely because
visualization rows are capped. Add a limit only when the query prototype or
runtime evidence demonstrates that the uncapped operation is unsafe.

The hierarchy uses one global chronological observation cap across the
session. If the focused observation is outside the normal window, it replaces
the last normal row so the hard cap remains true. Its synthetic trace wrapper
is always included, but omitted ancestors are not force-loaded; the focused
observation is rendered as detached and visibly qualified.

`observationCount`, `returnedObservations`, and the observation cap count only
real persisted observations. Synthetic session and trace wrappers never count.
The query prototype must compare current event-row behavior with latest-version
deduplication before the contract mandates deduplication: correctness should be
improved only if it does not create unacceptable ClickHouse strain. Whichever
row semantics are selected must be used consistently for returned and total
counts, row selection, and aggregate metrics.

### Session Graph Contract

Graph data remains a dedicated lightweight contract rather than including I/O
or full detail rows:

```ts
type SessionGraphRequest = {
  projectId: string;
  sessionId: string;
};

type SessionGraphSource = {
  scope: { kind: "session"; projectId: string; sessionId: string };
  traces: Array<{
    id: string;
    name: string | null;
    startTime: Date;
    endTime: Date;
    isInFlight: boolean;
    observations: Array<{
      traceId: string;
      id: string;
      parentObservationId: string | null;
      name: string;
      observationType: string;
      startTime: Date;
      endTime: Date | null;
      sourceKind: "observation" | "trace-root";
      framework?: { kind: "langgraph"; node: string; step: number };
    }>;
  }>;
  completeness: {
    complete: boolean;
    reasons: Array<"trace-limit" | "observation-limit">;
    returnedTraces: number;
    totalTraces?: number;
    returnedObservations: number;
    totalObservations?: number;
  };
};
```

The pure graph normalizer converts this source into namespaced session, trace,
observation, aggregate, and system nodes. Persisted parent relationships remain
trace-qualified and can never resolve across traces. Aggregated graph logic,
however, runs across the complete bounded session source to match the current
single-source normalization model: repeated framework node names may merge
across traces, and inferred chronological flow edges may connect observations
from different traces. These are session flow edges, not parent relationships,
and merged nodes retain visible trace provenance.

Graph rendering uses a discriminated state rather than the current ambiguous
`isGraphViewAvailable` boolean:

```ts
type GraphViewState =
  | { status: "loading" }
  | { status: "error"; message: string; retryable: boolean }
  | {
      status: "unavailable";
      reason: "empty-session" | "no-graphable-data" | "trivial";
    }
  | {
      status: "limited";
      reasons: Array<
        | "source-incomplete"
        | "observation-limit"
        | "node-limit"
        | "edge-limit"
        | "layout-timeout"
      >;
    }
  | { status: "ready"; model: GraphModel };
```

Every state must be representable by a Storybook fixture before graph API work
begins.

Graph performance limits are independent from session-detail limits. The graph
contract reports the applied server source limit separately from client node,
edge, and layout limits. Multiple simultaneous limit reasons are preserved
rather than collapsed to one ambiguous reason.

### Query Requirements

- Read v4 data from `events_full`, not the legacy `traces` table.
- Filter by both `projectId` and `sessionId` at every relevant boundary.
- Exclude deleted events.
- Use the event-row semantics validated by the query prototype consistently
  across rows, counts, and metrics.
- Use deterministic ordering, including stable tie-breakers.
- Keep the query bounded and avoid an unbounded client-side fan-out over trace
  IDs.
- Return the cap from the server rather than duplicating it in the client.
- Use a session-specific cap rather than implicitly reusing
  `MAX_OBSERVATIONS_PER_TRACE`.
- Ensure authorization does not rely only on the source trace ID.
- Benchmark current event-row behavior against latest-version deduplication in
  the query prototype before requiring a more expensive deduplication path.

Existing event-based session aggregation in
`packages/shared/src/server/services/sessions-ui-table-events-service.ts` can
inform or supply aggregate metrics, but session detail additionally needs the
bounded observation set.

The query and router implementing these contracts are intentionally delivered
after the Storybook and page-integration phases.

## Session Visualization Model

Represent session structure explicitly:

```text
SESSION
├── TRACE A
│   └── observation tree
├── TRACE B
│   └── observation tree
└── TRACE C
    └── observation tree
```

The `SESSION` row is the requested synthetic session root. It is a synthetic UI
node, not a persisted observation. Keeping it explicit prevents persisted-data
behavior such as observation fetching, comments, scores, or deletion from being
accidentally applied to the root.

Extend the visualization node type with `SESSION` and use stable synthetic IDs:

```ts
sessionNodeId(sessionId);
traceNodeId(traceId);
```

Session tree rules:

- The session node is the single root.
- Every trace gets a synthetic trace wrapper beneath the session, including v4
  traces that currently render root observations directly.
- Real observation hierarchy remains scoped to its trace.
- Parent links must never connect observations across traces unless that becomes
  an explicit supported data-model relationship.
- Trace roots are ordered by start time with deterministic tie-breakers.
- Synthetic IDs cannot collide with persisted observation IDs.
- Structured entity references own behavior and selection. Opaque renderer keys
  are generated separately and never sent to APIs.

Prefer a dedicated `buildSessionUiData` that reuses the existing per-trace tree
builder. Do not make the existing trace path more generic than necessary in the
first iteration.

## Metrics

The synthetic session root owns session-level aggregates:

- Cost: sum across the session.
- Usage: sum across the session.
- Duration: earliest observation start through latest observation end.
- Scores: session-targeted scores.
- Trace count and observation count.

Synthetic trace children retain trace-local aggregates. Observation rows retain
their existing values.

Prefer authoritative server-side session aggregates so metrics remain complete
when visualization data is capped. The UI must communicate whether displayed
metrics are complete or partial.

Visualization and metric completeness are independent. A capped tree,
timeline, or graph may be partial while uncapped session aggregates and counts
remain complete. Completeness means complete relative to rows currently
queryable under the endpoint's selected event-row semantics; the API does not
claim to detect historical retention loss or data that was never ingested.

## Detail Panel

The selected node determines detail content:

- Persisted observation: observation detail.
- Synthetic trace node: trace aggregate detail.
- Synthetic session node: session aggregate detail.

Synthetic IDs must never be sent to observation-by-ID endpoints.

Actions and page chrome are scope-aware:

- Observation scope shows observation-relevant title and actions.
- Trace scope preserves existing trace title, sharing, and deletion actions.
- Session scope shows a session title and only session-compatible actions.
- Do not expose trace deletion as an action on the synthetic session root.

## Timeline

Session scope uses one temporal frame:

- Origin: earliest observation start in the session.
- Duration: latest observation end minus the origin.
- Session row: complete session span.
- Trace rows: trace-local spans.
- Observation rows: actual timestamps.
- Gaps and overlaps between traces remain visible.
- Heatmap denominators use session totals at the session root and trace totals at
  trace roots where appropriate.

Audit assumptions named `traceStartTime`, `traceDuration`, and
`startTimeSinceTrace`. Either make them scope-neutral or explicitly document
that they refer to the active aggregate visualization.

## Graph

`TraceGraphDataProvider` and its endpoints currently accept one trace ID.
Session scope therefore requires a session graph query rather than a client-side
collection of independent trace requests.

The session graph path must:

- Filter by `projectId` and `sessionId`.
- Use graph-specific server source limits independent from the session-detail
  observation cap.
- Preserve trace identity on every graph node.
- Add the synthetic session root and synthetic trace roots.
- Keep real parent relationships within their trace.
- Apply current graph aggregation across the bounded session source, including
  repeated-name merging and inferred chronological flow across traces.
- Namespace graph keys where current logic assumes trace-local uniqueness.
- Preserve the existing graph node safety threshold.
- Disable the graph with a clear reason when the session is too large.

## Truncation UX

Generalize the current trace truncation presentation for trace and session
scopes:

- Show loaded count, total count when known, and the applied cap.
- State whether aggregate metrics cover the complete scope.
- Explain that the tree, timeline, and graph may show only part of the session.
- Keep and visibly qualify a focused observation whose ancestors were omitted.
- Apply the graph safety threshold separately from the server observation cap.

## Affected Component Inventory

The following inventory determines which files are documented unchanged,
split, extended, or left as connected adapters. A component is Storybook-safe
only when it has no private API access and no React context dependency.

### Detail and Aggregation Controls

| Current component                                                                                     | Current constraint                                                                                    | Storybook-first change                                                                                                                     | New functionality after documentation                                                              |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------- | ----------- | ----- | ------------- | ---------------------------------------------------------------------- |
| `web/src/features/traces/components/ObservationDetailView/ObservationDetailView.tsx`                  | Owns trace/view context, observation I/O, comments, media, RBAC, score behavior, and detail rendering | Extract a single-export, props-only `ObservationDetailContent`; keep the current file as its connected adapter                             | Render observation-only scope and normalized observation metrics without mounting trace navigation |
| `web/src/features/traces/components/ObservationDetailView/components/ObservationDetailViewHeader.tsx` | Reads trace/view context, mobile state, RBAC, and aggregation-specific metrics                        | Extract `ObservationDetailHeaderView` with prepared title, badges, metrics, action slots, and aggregation selector slot                    | Show the controlled Observation/Trace/Session selector and scope-specific metrics                  |
| `web/src/features/traces/components/TraceDetailView/TraceDetailView.tsx`                              | Owns contexts, comments/media queries, parser work, score invalidation, and tabs                      | Extract a complete props-only `TraceDetailContentView` from the content/header/tab pieces; retain network-heavy preparation in the adapter | Render the complete trace-scope detail in the pure aggregation workspace                           |
| `web/src/features/traces/components/TraceDetailView/components/TraceDetailViewHeader.tsx`             | Computes aggregate metrics and reads view/mobile contexts                                             | Extract `TraceDetailHeaderView` with normalized metrics and slots                                                                          | Present the same controlled aggregation selector in trace scope                                    |
| `web/src/features/traces/components/TracePanelDetail.tsx`                                             | Reads selection and trace contexts and may fetch a selected observation                               | Extract `TracePanelDetailView` using a discriminated `loading                                                                              | error                                                                                              | not-found | observation | trace | session` prop | Select pure observation, trace, or session detail content by node kind |
| New `DetailAggregationSelector`                                                                       | Does not exist                                                                                        | Build as a controlled pure component and story every enabled/disabled state                                                                | Add all three scopes and narrow-width behavior                                                     |
| New `SessionAggregateDetail`                                                                          | Does not exist                                                                                        | Build from the frozen `SessionDetailResponse` fixture                                                                                      | Show session metrics, scores, completeness, and metadata                                           |
| New `SessionDetailContentView`                                                                        | Does not exist                                                                                        | Build as a pure composition of `SessionAggregateDetail`, navigation, detail, and completeness slots                                        | Render the complete session scope inside `DetailAggregationWorkspace`                              |
| `web/src/features/traces/components/CollapsibleBadgeRow.tsx`                                          | Reads mobile state                                                                                    | Extract `CollapsibleBadgeRowView` with explicit layout props                                                                               | Validate dense aggregate badges and selector placement at drawer/mobile widths                     |

The selector belongs in the detail content header, not `PeekHeader` or the
Next.js page header. This keeps drawer and full-page behavior identical and
avoids modifying `web/src/components/table/peek/PeekHeader.tsx` solely for this
feature.

### Hierarchy, Search, and Selection

| Current component                                                                      | Current constraint                                                            | Storybook-first change                                                                                                                            | New functionality after documentation                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `web/src/features/traces/types/treeNode.ts`                                            | Uses `"TRACE"` as both entity kind and synthetic-node proxy                   | Introduce a discriminated `HierarchyNode` contract before view changes                                                                            | Add explicit session, trace, and observation node kinds                                       |
| `web/src/features/traces/fns/treeBuilding.ts`                                          | Pure but trace-specific; v4 traces can omit wrappers                          | Preserve the trace builder and define a fixture-backed pure `buildSessionUiData` contract                                                         | Compose a session root plus explicit trace wrappers without changing existing trace semantics |
| `web/src/features/traces/components/VirtualizedTree.tsx`                               | Already props-driven and API/context-free                                     | Add stories documenting current trace, collapse, selection, empty, and deep-tree behavior before modification                                     | Add complete session, mixed trace, detached observation, and large-session stories            |
| `web/src/features/traces/components/VirtualizedTreeNodeWrapper.tsx`                    | Already pure, but `nodeType` may not represent Session                        | Add baseline stories for root, depth, collapse, and selection                                                                                     | Support a Session badge or caller-provided leading visual and add session-root stories        |
| `web/src/features/traces/components/SpanContent.tsx`                                   | Reads trace-data and view-preference contexts despite being visually reusable | Extract `SpanContentView` with resolved scores, comments, metrics, labels, preferences, and callbacks; story current observation/trace rows first | Add session row semantics, aggregate labels, session scores, and synthetic-node behavior      |
| `web/src/features/traces/components/TraceTree.tsx`                                     | Context, URL selection, analytics, playhead, and observation prefetch         | Keep as an adapter; extract a controlled `HierarchyTree` composition using the three pure components above                                        | Add a separate session adapter later; never branch network behavior inside the pure tree      |
| `web/src/features/traces/components/TraceSearchList.tsx` and `TraceSearchListItem.tsx` | Context, analytics, prefetch, and trace-relative subtitles                    | Extract `HierarchySearchResults` and `HierarchySearchListItemView`; story current trace search first                                              | Search session, trace, and observation nodes with explicit breadcrumbs and selection targets  |
| `web/src/features/traces/hooks/useHandlePrefetchObservation.ts`                        | Treats every non-TRACE node as an observation in the current trace            | No story; keep as integration logic                                                                                                               | Switch on `HierarchyNode.kind` and prefetch only observations using their owning trace ID     |
| `web/src/features/traces/hooks/useSelectTraceNode.ts`                                  | Emits trace analytics and writes a node ID without entity kind                | No story; keep trace adapter unchanged initially                                                                                                  | Add a session selection adapter that accepts `DetailSelectionTarget`                          |

`flattenTree`, visual-depth helpers, and timeline calculations are already pure
and can be reused by fixture builders. They do not need stories unless their
observable rendering behavior changes.

### Timeline and Navigation

| Current component                                                                                            | Current constraint                                                                            | Storybook-first change                                                                                             | New functionality after documentation                                                                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `web/src/features/traces/components/TraceTimelineDense/TimelineDense.tsx`                                    | Already controlled, context-free, and extensively storyed                                     | Add a canonical current-trace fixture if one is not already explicit                                               | Add session-wide, overlapping-trace, idle-gap, truncated, and mobile stories using the shared hierarchy fixture   |
| `web/src/features/traces/components/TraceTimelineDense/TraceTimelineCompact.tsx`                             | Context, analytics, playback, and prefetch adapter                                            | Keep unstoryed                                                                                                     | Add a session adapter using the same `TimelineDense` renderer                                                     |
| `web/src/features/traces/components/TraceTimeline/TraceTimeline.tsx`                                         | Active classic renderer; combines context, selection, playback, virtualization, and rendering | Extract a controlled `ClassicTimelineView` and add stories that preserve current trace behavior before changing it | Add the same session fixtures so classic desktop and mobile behavior are modeled, not only the compact preview    |
| `web/src/features/traces/components/TracePanelNavigation.tsx`                                                | Reads search context, URL view state, and feature flags                                       | Extract and story a props-only `HierarchyNavigationContent`                                                        | Switch fixture-backed Tree, Timeline, and Search content                                                          |
| `web/src/features/traces/components/TracePanelNavigationHeader/TracePanelNavigationHeader.tsx`               | Reads multiple contexts, URL state, analytics, and owns trace download                        | Extract `HierarchyNavigationToolbarView` with callbacks and availability props; story current trace controls first | Add session labels, controls, disabled graph reasons, and session download slot without implementing download yet |
| `web/src/features/traces/components/TracePanelNavigationLayoutDesktop/TracePanelNavigationLayoutDesktop.tsx` | Reads layout/trace/graph contexts and local storage                                           | Extract and story `NavigationPanelFrame` with header, notice, primary, and secondary slots                         | Compose hierarchy navigation and graph without context or persisted layout state                                  |
| `web/src/features/traces/components/TraceLayoutMobile.tsx`                                                   | URL-backed tabs and selection context                                                         | Extract `MobileHierarchyTabsView`; story current Tree/Timeline/Graph/Data tabs first                               | Model Observation scope with Data only and Session scope with hierarchy tabs                                      |
| `web/src/features/traces/components/TraceLayoutDesktop.tsx`                                                  | Resizable browser layout with context and persisted state                                     | Do not split unless integration requires aggregate-specific behavior                                               | Reuse through connected adapters; model the feature composition in a fixed Storybook frame instead                |

Both active timeline paths must be represented. Modeling only `TimelineDense`
would miss the classic timeline that remains the mobile implementation and the
desktop implementation when the compact preview is disabled.

### Graph

| Current component                                                                                            | Current constraint                                                                                       | Storybook-first change                                                                                                                             | New functionality after documentation                                                              |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `web/src/features/traces/contexts/TraceGraphDataContext.tsx`                                                 | Fetches trace-scoped data, computes bounds, chooses API, and collapses availability to booleans          | Keep as an unstoryed trace adapter                                                                                                                 | Later consume the normalized graph contract; add a separate session query adapter                  |
| `web/src/features/traces/components/TraceGraphView/TraceGraphView.tsx`                                       | Reads graph/playhead/preferences/mobile contexts and analytics                                           | Keep as connected adapter                                                                                                                          | Translate context state and `GraphEntityRef` selections into the pure view                         |
| `web/src/features/trace-graph-view/components/TraceGraphView.tsx`                                            | Takes data props but owns URL params, graph normalization, selection cycling, and active-node projection | Split into a controller/model adapter and a props-only `GraphView`                                                                                 | Render trace/session graph modes from `GraphViewState` and emit entity selections                  |
| `web/src/features/trace-graph-view/components/ElkGraphRenderer.tsx`                                          | API-free but owns worker layout, ResizeObserver, d3 zoom, retries, and transient layout states           | Extract and story a deterministic `PositionedGraphCanvas` that receives a completed layout; keep worker/layout orchestration in `ElkGraphRenderer` | Story selected, active, compact, and dense positioned graphs without depending on asynchronous ELK |
| `web/src/features/trace-graph-view/components/GraphNode.tsx`                                                 | Already prop-driven                                                                                      | Add baseline node stories before extending its visual variants                                                                                     | Add session root, trace root, selected aggregate, and active observation variants                  |
| `web/src/features/trace-graph-view/buildStepData.ts`, `buildGraphCanvasData.ts`, and `buildExpandedGraph.ts` | Pure, but IDs, start/end nodes, names, and sibling ordering assume one trace                             | Freeze current trace fixtures before changing normalization                                                                                        | Namespace nodes, add explicit roots, and prevent cross-trace parent/flow edges                     |

No graph stories currently exist. Graph work therefore begins by establishing
the pure model/view boundary and documenting current trace behavior, not by
adding a session endpoint.

### Truncation and Load States

| Current component                                                                                       | Current constraint                                                                                      | Storybook-first change                                                                                                 | New functionality after documentation                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `web/src/features/traces/components/TraceTruncationNotice.tsx`                                          | Reads trace-data context                                                                                | Extract `AggregationTruncationNotice` with explicit scope/count/completeness props and story existing trace copy first | Add session complete-metrics/partial-visualization states                                      |
| `web/src/features/traces/components/TraceDetailBody.tsx`                                                | Props-driven but only distinguishes missing data with a skeleton and mounts the connected Trace feature | Keep as trace adapter; extract and story a focused pure `DetailLoadStateView`                                          | Model loading, unauthorized, not-found, generic error, and unavailable scope consistently      |
| `web/src/features/traces/TracePage.tsx` and `web/src/components/table/peek/peek-observation-detail.tsx` | Router/auth/network controllers with inconsistent missing/error handling                                | No stories and no early changes                                                                                        | Integrate the storyed load-state and aggregation components after the pure feature is complete |

### Existing Session Components

`ModernSessionHeader` and `ModernSessionSidebar` already have stories, but
`ModernSession.tsx` is a query-driven feed with a different incremental data
model. Reuse its visual language and fixture ideas where helpful; do not make it
the controller or data source for this feature. Session aggregation gets a
dedicated pure hierarchy model shared by tree, timeline, search, graph, and
detail stories.

## Storybook Modeling Plan

Storybook stories are only added for components that receive data and state
through typed props, expose actions through callbacks, and have no private API
or React context dependency. Connected wrappers remain in place but are not
storyed.

Each extracted Storybook surface lives in its own file with exactly one
exported/public component, as required by
`web/storybook/docs/WritingGoodStories.mdx`.

For every existing component that must change:

1. Extract a pure view if required.
2. Add stories that preserve and document the current trace behavior.
3. Review that baseline before extending the component contract.
4. Add the new aggregation behavior and its stories.

This avoids using a refactor and a feature change to silently redefine existing
behavior at the same time.

### Shared Contract Fixtures

Create one small, typed fixture family from the frozen API contracts. Reuse it
across detail, tree, search, timeline, graph, truncation, mobile, and feature
composition stories.

The canonical complete-session fixture contains:

```text
SESSION "Support conversation"
├── TRACE "Turn 1"
│   ├── SPAN "agent"
│   │   ├── GENERATION "reasoning"
│   │   └── TOOL "search"
│   └── EVENT "response"
├── TRACE "Turn 2"
│   └── GENERATION "follow-up"
└── TRACE "Turn 3" (in flight)
```

Add focused variants rather than one oversized fixture:

- Mixed v3 and v4 trace roots.
- Multiple root observations within one trace.
- Overlapping traces and idle gaps.
- Same observation ID in different traces to validate namespacing.
- Missing parent in an explicitly partial response.
- Focused observation outside the normal cap.
- Empty and in-flight traces.
- Large/truncated session metadata without thousands of hand-written rows.
- Graph source with repeated framework node names in different traces.

Fixtures use `satisfies SessionDetailResponse` or
`satisfies SessionGraphSource`. Do not infer UI contracts from mock objects.

### Aggregation Selector

Create the pure controlled component:

```ts
type DetailAggregationSelectorProps = {
  value: DetailAggregation;
  observationDisabledReason?: string;
  sessionDisabledReason?: string;
  onChange: (value: DetailAggregation) => void;
};
```

Stories:

- `TraceSelected`
- `ObservationSelected`
- `SessionSelected`
- `WithoutSelectedObservation`
- `WithoutSession`
- `WithLongUnavailableReason`
- `Narrow`

The selector is modeled independently before being added to any detail header.

### Existing Detail Views First

After extracting pure detail/header views, document current states before
adding aggregation:

- Observation `Generation`, `Span`, and `Event`.
- Observation with input/output, usage/cost, scores, error, and long content.
- Trace aggregate header and tabs.
- Long names and dense badge rows at full-page and drawer widths.
- Existing action and action-menu slots.
- Current loading, not-found, and generic error presentation.

Then add:

- Observation scope without navigation.
- Trace scope with the aggregation selector.
- Session aggregate detail with complete metrics.
- Session aggregate detail with partial metrics.
- Session root, trace root, and observation selections.
- Unavailable Observation and Session choices.

`TracePanelDetailView` stories cover the discriminated detail states without
mounting selection context or observation queries.

### Hierarchy Tree and Search

First document existing trace behavior in:

- `VirtualizedTree.stories.tsx`.
- `VirtualizedTreeNodeWrapper.stories.tsx`.
- `SpanContentView.stories.tsx` after extraction.
- `HierarchyTree.stories.tsx` after controlled composition is extracted.
- `HierarchySearchResults.stories.tsx` after search presentation is extracted.

Baseline stories cover trace roots, observation roots, selection, collapse,
empty data, deep nesting, comments, scores, usage, and cost.

Then add:

- `CompleteSession`
- `MixedTraceFormats`
- `SessionSelected`
- `TraceSelected`
- `ObservationSelected`
- `CollapsedSession`
- `CollapsedTrace`
- `DetachedFocusedObservation`
- `TruncatedSession`
- `LongNames`
- `SearchesAcrossHierarchyLevels`

The complete-session tree story is the primary proof that the synthetic
hierarchy works before any query or page uses it.

### Timeline

Use the shared fixture for both active timeline implementations.

For `TimelineDense`, preserve existing stories and add a canonical trace story
before session-specific additions. For the classic timeline, first extract and
story `ClassicTimelineView` with current trace behavior.

Then add to both renderers:

- `SessionAcrossTraces`
- `TracesSeparatedByIdleGap`
- `OverlappingTraces`
- `InFlightTrace`
- `TruncatedSession`
- `SessionSelected`
- `ObservationSelected`
- `Narrow`
- `Mobile`

Only observation nodes participate in playback unless an explicit aggregate
activity design is added. Session and trace grouping rows remain non-playable.

### Graph

Before session changes, split graph modeling, URL/controller behavior, and
rendering. Add stories documenting the current single-trace graph:

- Expanded trace.
- Aggregated repeated nodes.
- Selected and active observation.
- Layout loading, slow, error, retry, and existing size-limit behavior.
- Empty and structurally trivial trace.

Then extend the pure normalizer and `GraphView` with:

- `SessionWithTwoTraces`
- `ParallelTracesWithoutCrossTraceEdges`
- `RepeatedNamesAcrossTraces`
- `CollidingObservationIdsAcrossTraces`
- `LegacyParentlessObservations`
- `V4TraceRootRows`
- `PartialSourceWithMissingParent`
- `SessionSelected`
- `TraceSelected`
- `ObservationSelected`
- `NoGraphableObservations`
- `SourceIncomplete`
- `ObservationLimit`
- `NodeLimit`
- `EdgeLimit`

Story `PositionedGraphCanvas` with a supplied layout. Do not add context or API
decorators to make the existing connected graph component appear storyable.

### Truncation and Mobile

After extracting pure views, document existing trace behavior first:

- Existing trace cap copy.
- Focused detached observation.
- Focused misplaced observation.
- Current mobile Tree/Timeline/Graph/Data tabs.

Then add:

- Session visualization truncated with complete aggregate metrics.
- Session visualization truncated with partial metrics.
- Unknown total.
- Observation scope showing only Data on mobile.
- Session scope with Tree/Timeline/Graph/Data.
- Graph unavailable or disabled with a visible reason.

### Complete Feature Composition

After every leaf component is storyed, add one intentional feature-level pure
composition such as `DetailAggregationWorkspace`. It receives the complete
fixture-backed view model and controlled callbacks; it must not import router,
tRPC, auth, analytics, feature flags, or application contexts.

Composition stories:

- `ObservationScope`
- `TraceScope`
- `SessionScope`
- `SessionScopeWithTreeSelection`
- `SessionScopeWithTimelineSelection`
- `SessionScopeWithGraphSelection`
- `SessionUnavailable`
- `TruncatedSession`
- `Loading`
- `Error`
- `NarrowDrawer`
- `Mobile`

This page-sized story is intentional: it proves the full interaction model
before integration. Smaller component stories remain the primary design and
debugging surfaces.

## Storybook Conventions

Follow `web/storybook/docs/WritingGoodStories.mdx`:

- Use CSF Next through the repository Storybook preview API.
- Cover exactly one exported public component per story file.
- Do not use context decorators or mock private APIs.
- Do not introduce MSW.
- Keep fixtures small.
- Use Storybook Actions via `fn()` for callbacks.
- Name stories after user-visible states.
- Avoid page-level compositions.
- Use play functions only for meaningful user interactions, not setup.
- Put interaction-focused play functions in dedicated stories whose display
  names start with `(Test)`, and sort those stories after showcase stories.
- Do not duplicate stories for light and dark mode.

## Delivery Sequence

### Phase 0: Freeze Contracts

1. Add client-safe `DetailAggregation`, `DetailSelectionTarget`,
   `HierarchyNode`, `SessionDetailRequest`, `SessionDetailResponse`,
   `SessionGraphRequest`, `SessionGraphSource`, `GraphModel`, and
   `GraphViewState` definitions.
2. Document request guarantees, authorization expectations, ordering, caps,
   focused-observation inclusion, metric completeness, and graph namespacing.
3. Add the canonical small fixtures using `satisfies` against those contracts.
4. Review the contracts against existing events/session repositories to confirm
   the fields can be produced without implementing a query yet.
5. Build and benchmark a query-only prototype against `events_full`. Compare
   current event-row semantics with latest-version deduplication, and validate
   aggregate cost, exact counts, deterministic global capping, focused-row
   replacement, and graph-source limits. Do not expose a procedure or connect
   UI code in this phase.

Exit condition: the future APIs have an agreed exact shape and every planned
Storybook state can be expressed by valid contract fixtures.

### Phase 1: Document Existing Pure Behavior

1. Add baseline stories to the already eligible `VirtualizedTree`,
   `VirtualizedTreeNodeWrapper`, `TimelineDense`, and `GraphNode` components.
2. Split `SpanContentView`, `ObservationDetailContent`,
   `ObservationDetailHeaderView`, `TraceDetailHeaderView`,
   `TraceDetailContentView`, `TracePanelDetailView`, `ClassicTimelineView`,
   `HierarchyTree`, `HierarchySearchResults`,
   `HierarchySearchListItemView`, `HierarchyNavigationContent`,
   `HierarchyNavigationToolbarView`, `NavigationPanelFrame`,
   `MobileHierarchyTabsView`, `CollapsibleBadgeRowView`,
   `AggregationTruncationNotice`, `DetailLoadStateView`, `GraphView`, and
   `PositionedGraphCanvas` from their connected owners.
3. Keep each existing component as a thin adapter around its extracted pure
   view so current application behavior remains unchanged.
4. Add stories for current trace/observation behavior before adding Session or
   aggregation props.

Exit condition: every component that will change has a pure Storybook surface
and its current behavior is reviewable without context or private API mocks.

### Phase 2: Model Aggregation Components

1. Build and story `DetailAggregationSelector` independently.
2. Extend pure detail headers and `TracePanelDetailView` for all three scopes.
3. Build and story `SessionAggregateDetail` from contract fixtures.
4. Build and story `SessionDetailContentView` from `SessionAggregateDetail` and
   fixture-backed navigation/detail slots.
5. Extend `AggregationTruncationNotice` and shared load states for session
   completeness and unavailable-scope states.
6. Add narrow drawer and mobile stories for the selector, headers, badges, load
   states, and detail bodies.

Exit condition: Observation, Trace, and Session detail states are completely
modeled without hierarchy navigation or network data.

### Phase 3: Model Session Hierarchy

1. Extend hierarchy consumers and builders against the discriminated nodes and
   namespaced synthetic IDs frozen in Phase 0.
2. Add pure `buildSessionUiData` while preserving the current trace builder.
3. Extend `SpanContentView`, `HierarchyTree`, and hierarchy search presentation
   for session, trace, and observation nodes.
4. Add complete-session, mixed-format, collapsed, selected, detached,
   truncated, search, and large-session stories.
5. Record every `type === "TRACE"` assumption in prefetch, playback, scores,
   search, and selection for Phase 6. Do not change those adapters yet.

Exit condition: the full session hierarchy and every node-selection target are
demonstrated in Storybook.

### Phase 4: Model Timeline and Graph

1. Add the session fixture suite to both `TimelineDense` and the extracted
   `ClassicTimelineView`.
2. Model playback stories with observation-only `activeIds`; defer connected
   playback adapter changes to Phase 6.
3. Freeze existing single-trace graph stories before changing graph
   normalization.
4. Add pure graph source normalization with namespaced session/trace roots,
   trace-qualified parent links, session-wide repeated-name aggregation, and
   inferred chronological flow across traces.
5. Extend `GraphView` and `PositionedGraphCanvas` for every ready, unavailable,
   limited, loading, and error state.
6. Add multi-trace session graph stories and selection stories for each entity
   kind.

Exit condition: tree, search, both timelines, and graph render the same fixture
and agree on IDs, selection targets, temporal bounds, and completeness.

### Phase 5: Complete Storybook Feature

1. Compose the pure `DetailAggregationWorkspace` from the storyed leaf
   components.
2. Add Observation, Trace, Session, unavailable, truncated, loading, error,
   narrow drawer, and mobile composition stories.
3. Add dedicated `(Test)` interaction stories for selector changes and node
   selections using controlled Storybook state only; keep them after showcase
   stories.
4. Review the complete feature in Storybook before touching real pages,
   drawers, URL hooks, tRPC hooks, or repositories.

Exit condition: product and engineering sign off on the fixture-backed feature
behavior and data contract.

### Phase 6: Connected UI Integration

Only after Storybook signoff:

1. Add URL parsing/history behavior for `aggregation`.
2. Add scope-aware controller state and query interfaces, initially typed
   against the frozen contracts.
3. Integrate the storyed views into the EventsTable observation drawer and full
   trace page while preserving Trace as the default.
4. Add node-kind-aware selection, prefetch, playback, actions, sharing, and
   mobile behavior.
5. Keep the future session data source behind the contract boundary; do not
   weaken or reshape the UI contract to match an incidental backend result.

At this point all page changes are composition and controller work around
already reviewed components.

### Phase 7: API Implementation and Final Hookup

This is the final implementation phase and the first phase that changes events
routers, session graph procedures, ClickHouse repositories, or service queries.

1. Implement the bounded session-detail repository/service from `events_full`.
2. Implement the protected session-detail procedure returning exactly
   `SessionDetailResponse`.
3. Implement the lightweight session graph query returning exactly
   `SessionGraphSource`.
4. Apply project/session authorization, deterministic ordering, deduplication,
   caps, total counts, focused-observation inclusion, and metric completeness
   semantics defined in Phase 0.
5. Connect the Phase 6 query interfaces to the real tRPC procedures.
6. Verify that no Storybook fixture-only field or fallback is required by the
   real response.

If the backend cannot efficiently fulfill the frozen contract, stop and revise
the contract and affected stories explicitly. Do not add hidden client-side
fallbacks or silently downgrade complete metrics to partial metrics.

### Production Rollout

The complete Storybook model is reviewed as one product design, then production
ships in independently reviewable stages:

1. Observation and Trace selector and strict observation-only detail behavior.
2. Session aggregate detail, hierarchy tree, and search backed by the real
   session-detail API.
3. Both active session timeline implementations.
4. Session graph and its independent query and rendering limits.

Each stage may remain behind its own rollout control until its connected UI and
backend behavior are verified. A later stage must not block shipping a reviewed
earlier stage.

## Deferred Work

Automated unit, integration, server, and browser tests are intentionally
deferred for this iteration. Storybook provides visual and interaction coverage
only for pure components; it does not verify backend query correctness,
authorization, cross-scope data loading, or full-page integration. These remain
known verification gaps for a later test pass.

Also deferred unless required during implementation:

- Applying aggregation selection to legacy, annotation, and experiment detail
  surfaces.
- Paginated or incrementally loaded session trees.
- Persisting aggregation as a user preference outside the URL.
- Session deletion or other new destructive session actions.
