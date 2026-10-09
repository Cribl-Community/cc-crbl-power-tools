import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Pill, Spinner, Text, TextField } from '@capra/core';
import { isConnected } from '../api/client';
import { commitGroup, deployGroup, listWorkerGroups } from '../api/destinations';
import { listGroupSources } from '../api/stream';
import {
  getGroupSource,
  listGroupBreakerRulesets,
  updateGroupSource,
} from '../api/sourceBreakers';
import type { EventBreakerRuleset, StreamInput, WorkerGroup } from '../api/types';
import { runBatch, type BatchItemResult } from '../lib/batch';
import {
  buildSourceUpdateBody,
  checkEligibility,
  currentRulesets,
  currentStaleFlushMs,
  filterSources,
  planChanges,
  sourceTypes,
  summarizePlan,
  supportsStaleFlush,
  validateStaleFlushMs,
  type EditMode,
  type PlanRow,
} from '../lib/sourceBulkEdit';
import { LabeledSwitch } from '../components/LabeledSwitch';
import { OrderedListEditor } from '../components/OrderedListEditor';
import { ProgressBar } from '../components/ProgressBar';
import { ResultsSummary, type ResultRow } from '../components/ResultsSummary';

type View = 'table' | 'preview' | 'running' | 'results';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const EDIT_MODES: { key: EditMode; label: string; hint: string }[] = [
  { key: 'replace', label: 'Replace', hint: 'The selected rulesets become the whole list.' },
  { key: 'append', label: 'Append', hint: 'Add the selected rulesets after existing ones.' },
  { key: 'remove', label: 'Remove selected', hint: 'Remove the selected rulesets.' },
  { key: 'clear', label: 'Clear all', hint: 'Remove every ruleset from the Source.' },
];

interface DeployStatus {
  attempted: boolean;
  deployRequested: boolean;
  committed: boolean;
  deployed: boolean;
  error?: string;
  note?: string;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render a ruleset list as ordered chips, or an explicit "none". */
function RulesetChips({ value, kind }: { value: string[]; kind: 'current' | 'new' }) {
  if (value.length === 0) return <span className="muted">none</span>;
  return (
    <span className="chip-row">
      {value.map((r, i) => (
        <span key={`${r}-${i}`} className={`diff-chip diff-chip-${kind}`}>
          {i + 1}. {r}
        </span>
      ))}
    </span>
  );
}

export function SourceBulkEdit() {
  const connected = isConnected();

  // --- worker groups ---
  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  const [groupsState, setGroupsState] = useState<LoadState>('idle');
  const [groupsError, setGroupsError] = useState('');
  const [groupId, setGroupId] = useState('');

  // --- sources in the selected group ---
  const [sources, setSources] = useState<StreamInput[]>([]);
  const [sourcesState, setSourcesState] = useState<LoadState>('idle');
  const [sourcesError, setSourcesError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // --- Event Breaker rulesets available in the group (picker options) ---
  const [rulesets, setRulesets] = useState<EventBreakerRuleset[]>([]);
  const [rulesetsState, setRulesetsState] = useState<LoadState>('idle');
  const [rulesetsError, setRulesetsError] = useState('');

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const [mode, setMode] = useState<EditMode>('replace');
  const [selectedRulesets, setSelectedRulesets] = useState<string[]>([]);
  const [setStale, setSetStale] = useState(false);
  const [staleText, setStaleText] = useState('');

  // Dry run is ON by default: previewing must never be able to write by accident.
  const [dryRun, setDryRun] = useState(true);
  const [commitAfter, setCommitAfter] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [deployAfter, setDeployAfter] = useState(false);

  const [view, setView] = useState<View>('table');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);
  const [skippedRows, setSkippedRows] = useState<PlanRow[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);

  // Load worker groups once, on mount.
  useEffect(() => {
    if (!connected) {
      setGroupsState('error');
      setGroupsError('This app must run inside Cribl to reach the API.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setGroupsState('loading');
    setGroupsError('');
    listWorkerGroups(controller.signal)
      .then((g) => {
        if (cancelled) return;
        setGroups(g);
        setGroupsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setGroupsState('error');
        setGroupsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected]);

  // Sources for the selected group; reloaded on group change and after applying.
  useEffect(() => {
    if (!connected || !groupId) {
      setSources([]);
      setSourcesState('idle');
      setSelection(new Set());
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSourcesState('loading');
    setSourcesError('');
    setSelection(new Set());
    listGroupSources(groupId, controller.signal)
      .then((rows) => {
        if (cancelled) return;
        setSources(rows);
        setSourcesState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setSourcesState('error');
        setSourcesError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected, groupId, reloadToken]);

  // Event Breaker rulesets for the selected group (picker options).
  useEffect(() => {
    if (!connected || !groupId) {
      setRulesets([]);
      setRulesetsState('idle');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setRulesetsState('loading');
    setRulesetsError('');
    listGroupBreakerRulesets(groupId, controller.signal)
      .then((r) => {
        if (cancelled) return;
        setRulesets(r);
        setRulesetsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setRulesetsState('error');
        setRulesetsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected, groupId]);

  const groupLabel = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return g ? g.name || g.id : groupId;
  }, [groups, groupId]);

  const types = useMemo(() => sourceTypes(sources), [sources]);
  const filtered = useMemo(
    () => filterSources(sources, filterText, typeFilter),
    [sources, filterText, typeFilter],
  );

  // Only eligible Sources can be selected, so bulk actions never select a disabled row.
  const eligibleFiltered = useMemo(
    () => filtered.filter((s) => checkEligibility(s).eligible),
    [filtered],
  );
  const selectedSources = useMemo(
    () => sources.filter((s) => selection.has(s.id)),
    [sources, selection],
  );

  const staleError = useMemo(() => {
    if (!setStale) return null;
    if (staleText.trim() === '') return 'Enter a buffer timeout in milliseconds.';
    return validateStaleFlushMs(Number(staleText));
  }, [setStale, staleText]);

  const staleMs = setStale && !staleError ? Number(staleText) : undefined;

  const plan = useMemo(
    () => planChanges(selectedSources, { mode, selected: selectedRulesets, staleFlushMs: staleMs }),
    [selectedSources, mode, selectedRulesets, staleMs],
  );
  const planSummary = useMemo(() => summarizePlan(plan), [plan]);
  const changedRows = useMemo(() => plan.filter((r) => r.changed), [plan]);

  const needsRulesets = mode !== 'clear';
  const canPreview =
    sourcesState === 'ready' &&
    selectedSources.length > 0 &&
    !staleError &&
    (!needsRulesets || selectedRulesets.length > 0 || setStale);

  const allEligibleSelected =
    eligibleFiltered.length > 0 && eligibleFiltered.every((s) => selection.has(s.id));
  const someEligibleSelected = eligibleFiltered.some((s) => selection.has(s.id));

  function toggleOne(id: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelection((prev) => {
      const next = new Set(prev);
      if (allEligibleSelected) eligibleFiltered.forEach((s) => next.delete(s.id));
      else eligibleFiltered.forEach((s) => next.add(s.id));
      return next;
    });
  }

  const modeLabel = EDIT_MODES.find((m) => m.key === mode)?.label ?? mode;
  const actionSummary = `${modeLabel} Event Breaker rulesets on ${changedRows.length} source${
    changedRows.length === 1 ? '' : 's'
  }`;

  /**
   * Apply one planned change: re-read the Source's live config, then PATCH the full
   * object back with only the Event Breaker fields replaced. Writing the previewed
   * `after` list keeps the applied result identical to what the user confirmed.
   */
  async function applyToRow(row: PlanRow): Promise<void> {
    const fresh = await getGroupSource(groupId, row.source.id);
    const nextStale = supportsStaleFlush(fresh) ? staleMs : undefined;
    await updateGroupSource(groupId, buildSourceUpdateBody(fresh, row.after, nextStale));
  }

  function toResultRow(r: BatchItemResult<PlanRow>): ResultRow {
    return { label: r.item.source.id, ok: r.ok, error: r.error, dryRun: r.dryRun };
  }

  async function runApply() {
    setConfirmOpen(false);
    setView('running');
    setResults([]);
    setDeployStatus(null);
    setSkippedRows(plan.filter((r) => !r.changed));
    setProgress({ done: 0, total: changedRows.length });

    const batch = await runBatch(
      changedRows,
      applyToRow,
      (p) => setProgress({ done: p.done, total: p.total }),
      { dryRun },
    );
    setResults(batch.map(toResultRow));

    // Commit (and optionally deploy) once after the batch, and only when the user asked
    // for it and something actually changed.
    const changed = batch.filter((r) => r.ok && !r.dryRun).length;
    let deploy: DeployStatus = {
      attempted: false,
      deployRequested: deployAfter,
      committed: false,
      deployed: false,
    };
    if (!dryRun && commitAfter && changed > 0) {
      deploy = { ...deploy, attempted: true };
      try {
        const message =
          commitMessage.trim() ||
          `CC Cribl Power Tools: Event Breaker rulesets on ${changed} source${
            changed === 1 ? '' : 's'
          }`;
        const hash = await commitGroup(groupId, message);
        if (hash) {
          deploy = { ...deploy, committed: true };
          if (deployAfter) {
            await deployGroup(groupId, hash);
            deploy = { ...deploy, deployed: true };
          }
        } else {
          deploy = { ...deploy, committed: true, note: 'No pending changes to commit.' };
        }
      } catch (err) {
        deploy = { ...deploy, error: toMessage(err) };
      }
    }
    setDeployStatus(deploy);
    setView('results');
  }

  function startOver() {
    setView('table');
    setResults([]);
    setSkippedRows([]);
    setDeployStatus(null);
    setProgress({ done: 0, total: 0 });
    setSelection(new Set());
    setSelectedRulesets([]);
    // Refresh so the table reflects what was just written.
    setReloadToken((n) => n + 1);
  }

  // ---------- render guards ----------
  if (groupsState === 'loading' || groupsState === 'idle') {
    return (
      <div className="wf-center">
        <Spinner title="Loading worker groups…" />
      </div>
    );
  }

  if (groupsState === 'error') {
    return (
      <div className="wf-section">
        <Alert appearance="danger" title="Could not load worker groups">
          {groupsError}
        </Alert>
      </div>
    );
  }

  if (view === 'running') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          {dryRun ? 'Running dry run…' : 'Updating Event Breaker rulesets…'}
        </Text>
        <ProgressBar
          done={progress.done}
          total={progress.total}
          label={dryRun ? 'Sources validated' : 'Sources updated'}
        />
      </div>
    );
  }

  if (view === 'results') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          Results
        </Text>
        <CommitDeployAlert deploy={deployStatus} groupLabel={groupLabel} />
        <ResultsSummary noun="source" rows={results} />

        {skippedRows.length > 0 && (
          <>
            <Text as="h3" variant="heading-sm">
              Skipped — {skippedRows.length} source{skippedRows.length === 1 ? '' : 's'}
            </Text>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source ID</th>
                    <th>Type</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {skippedRows.map((r) => (
                    <tr key={r.source.id}>
                      <td>
                        <Text variant="code">{r.source.id}</Text>
                      </td>
                      <td>
                        <Text variant="code">{r.source.type ?? '—'}</Text>
                      </td>
                      <td>
                        <Text variant="body-sm-normal" color="subtle">
                          {r.skipReason ?? 'Skipped'}
                        </Text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="wf-actions">
          <Button variant="primary" onClick={startOver}>
            Back to sources
          </Button>
        </div>
      </div>
    );
  }

  if (view === 'preview') {
    return (
      <div className="wf-section">
        <div className="wf-actions wf-actions-between">
          <Text as="h2" variant="heading-md">
            Preview — {changedRows.length} of {plan.length} source
            {plan.length === 1 ? '' : 's'} will change
          </Text>
          <div className="wf-actions">
            <Button onClick={() => setView('table')}>Back</Button>
            <Button
              variant="primary"
              appearance={dryRun ? 'default' : 'danger'}
              disabled={changedRows.length === 0}
              onClick={() => (dryRun ? void runApply() : setConfirmOpen(true))}
            >
              {dryRun ? 'Run dry run (no writes)' : `Apply to ${changedRows.length}`}
            </Button>
          </div>
        </div>

        <Alert
          appearance={dryRun ? 'info' : 'warning'}
          title={dryRun ? 'Dry run' : 'Review before applying'}
        >
          {actionSummary} in worker group “{groupLabel}”.
          {planSummary.skipped > 0 &&
            ` ${planSummary.skipped} selected source${planSummary.skipped === 1 ? '' : 's'} will be skipped (${planSummary.ineligible} ineligible).`}
          {dryRun
            ? ' No changes will be written.'
            : commitAfter
              ? deployAfter
                ? ' The group will then be committed and deployed.'
                : ' The group will then be committed (deploy it yourself to go live).'
              : ' The group will NOT be committed — commit it yourself for the change to persist.'}
        </Alert>

        {changedRows.length === 0 && (
          <Alert appearance="info" title="Nothing to apply">
            None of the selected sources would change. Adjust the rulesets or the edit mode.
          </Alert>
        )}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Source ID</th>
                <th>Type</th>
                <th>Current rulesets</th>
                <th aria-hidden />
                <th>New rulesets</th>
                <th>Buffer timeout</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {plan.map((row) => (
                <tr key={row.source.id} className={row.changed ? undefined : 'row-skipped'}>
                  <td>
                    <Text variant="code">{row.source.id}</Text>
                  </td>
                  <td>
                    <Text variant="code">{row.source.type ?? '—'}</Text>
                  </td>
                  <td>
                    <RulesetChips value={row.before} kind="current" />
                  </td>
                  <td className="diff-arrow" aria-hidden>
                    →
                  </td>
                  <td>
                    {row.changed ? (
                      <RulesetChips value={row.after} kind="new" />
                    ) : (
                      <span className="muted">unchanged</span>
                    )}
                  </td>
                  <td>
                    {row.beforeStaleMs !== row.afterStaleMs ? (
                      <span className="diff-chip diff-chip-new">
                        {row.beforeStaleMs ?? 'default'} → {row.afterStaleMs}
                      </span>
                    ) : (
                      <span className="muted">{row.beforeStaleMs ?? 'default'}</span>
                    )}
                  </td>
                  <td>
                    {row.changed ? (
                      <Pill appearance="success" variant="muted">
                        Will change
                      </Pill>
                    ) : (
                      <Pill appearance="info" variant="muted">
                        {row.skipReason ?? 'Skipped'}
                      </Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Modal
          isOpen={confirmOpen}
          title={`Apply to ${changedRows.length} source${changedRows.length === 1 ? '' : 's'}?`}
          confirmButtonText={`Apply to ${changedRows.length}`}
          cancelButtonText="Cancel"
          onConfirm={() => void runApply()}
          onClose={() => setConfirmOpen(false)}
        >
          <Text>
            {actionSummary} in worker group “{groupLabel}”
            {commitAfter
              ? `, then ${deployAfter ? 'commit and deploy the group' : 'commit the group'}`
              : ''}
            .
          </Text>
          <Text color="attention">
            This overwrites the Event Breaker ruleset list on each source listed in the preview.
          </Text>
        </Modal>
      </div>
    );
  }

  // ---------- table view ----------
  return (
    <div className="wf-section">
      <div className="lake-form">
        <Text as="h3" variant="heading-sm">
          1. Worker group
        </Text>
        <div className="form-grid">
          <label className="field">
            <Text variant="body-sm-semibold">Worker group</Text>
            <select
              className="native-select"
              aria-label="Worker group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">Select a worker group…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name || g.id}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {groupId && (
        <>
          <div className="wf-toolbar">
            <TextField
              aria-label="Filter sources"
              placeholder="Filter by id or type"
              value={filterText}
              onChange={setFilterText}
            />
            <select
              className="native-select"
              aria-label="Filter by type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <div className="wf-toolbar-spacer" />
            <LabeledSwitch label="Dry run" checked={dryRun} onChange={setDryRun} />
          </div>

          {sourcesState === 'loading' && (
            <div className="wf-center">
              <Spinner title="Loading sources…" />
            </div>
          )}
          {sourcesState === 'error' && (
            <Alert appearance="danger" title="Could not load sources">
              {sourcesError}
            </Alert>
          )}
          {sourcesState === 'ready' && sources.length === 0 && (
            <Alert appearance="info" title="No sources">
              This worker group has no Sources.
            </Alert>
          )}

          {sourcesState === 'ready' && sources.length > 0 && (
            <>
              <div className="wf-selectbar">
                <Text variant="body-sm-normal" color="subtle">
                  {selection.size} selected · {filtered.length} shown · {sources.length} total ·{' '}
                  {filtered.length - eligibleFiltered.length} not editable
                </Text>
                <div className="wf-selectbar-actions">
                  <Button
                    size="sm"
                    onClick={toggleAllFiltered}
                    disabled={eligibleFiltered.length === 0}
                  >
                    {allEligibleSelected ? 'Deselect filtered' : 'Select filtered'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setSelection(new Set())}
                    disabled={selection.size === 0}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="col-check">
                        <Checkbox
                          aria-label="Select all eligible filtered sources"
                          checked={allEligibleSelected}
                          indeterminate={someEligibleSelected && !allEligibleSelected}
                          onChange={toggleAllFiltered}
                        />
                      </th>
                      <th>Source ID</th>
                      <th>Type</th>
                      <th>Enabled</th>
                      <th>Event Breaker rulesets</th>
                      <th>Buffer timeout (ms)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s) => {
                      const eligibility = checkEligibility(s);
                      const breakers = currentRulesets(s);
                      const stale = currentStaleFlushMs(s);
                      // Cribl treats a Source as enabled unless `disabled` is true.
                      const enabled = s.disabled !== true;
                      return (
                        <tr
                          key={s.id}
                          className={
                            selection.has(s.id)
                              ? 'row-selected'
                              : eligibility.eligible
                                ? undefined
                                : 'row-skipped'
                          }
                        >
                          <td className="col-check">
                            <Checkbox
                              aria-label={
                                eligibility.eligible
                                  ? `Select ${s.id}`
                                  : `${s.id} cannot be edited: ${eligibility.reason}`
                              }
                              checked={selection.has(s.id)}
                              disabled={!eligibility.eligible}
                              onChange={() => toggleOne(s.id)}
                            />
                          </td>
                          <td>
                            <Text variant="code">{s.id}</Text>
                          </td>
                          <td>
                            <Text variant="code">{s.type ?? '—'}</Text>
                            {!eligibility.eligible && (
                              <>
                                <br />
                                <Text variant="body-sm-normal" color="subtle">
                                  {eligibility.reason}
                                </Text>
                              </>
                            )}
                          </td>
                          <td>
                            {enabled ? (
                              <Pill appearance="success" variant="muted">
                                Enabled
                              </Pill>
                            ) : (
                              <Pill appearance="info" variant="muted">
                                Disabled
                              </Pill>
                            )}
                          </td>
                          <td>
                            <RulesetChips value={breakers} kind="current" />
                          </td>
                          <td>
                            {stale !== undefined ? (
                              <Text variant="code">{stale}</Text>
                            ) : (
                              <span className="muted">default</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <div className="wf-empty">
                    <Text color="subtle">No sources match the current filters.</Text>
                  </div>
                )}
              </div>

              {/* Bulk edit panel */}
              <div className="edit-panel">
                <Text as="h3" variant="heading-sm">
                  2. Edit Event Breaker rulesets
                </Text>
                <Text variant="body-sm-normal" color="subtle">
                  Applied to all {selection.size} selected source{selection.size === 1 ? '' : 's'}.
                  Ruleset order matters — Cribl applies them in order and the first match wins.
                </Text>

                {rulesetsState === 'error' && (
                  <Alert appearance="warning" title="Could not load Event Breaker rulesets">
                    {rulesetsError} You can still remove or clear rulesets.
                  </Alert>
                )}

                <div className="form-grid">
                  <label className="field">
                    <Text variant="body-sm-semibold">Edit mode</Text>
                    <select
                      className="native-select"
                      aria-label="Edit mode"
                      value={mode}
                      onChange={(e) => setMode(e.target.value as EditMode)}
                    >
                      {EDIT_MODES.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <Text variant="body-sm-normal" color="subtle">
                      {EDIT_MODES.find((m) => m.key === mode)?.hint}
                    </Text>
                  </label>
                </div>

                {needsRulesets && (
                  <div className="field">
                    <Text variant="body-sm-semibold">
                      {mode === 'remove' ? 'Rulesets to remove' : 'Rulesets (in order)'}
                    </Text>
                    <OrderedListEditor
                      value={selectedRulesets}
                      onChange={setSelectedRulesets}
                      placeholder={
                        rulesetsState === 'loading' ? 'Loading rulesets…' : 'Select a ruleset…'
                      }
                      options={rulesets.map((r) => ({ value: r.id, label: r.id }))}
                      emptyOptionsLabel="All rulesets already selected"
                    />
                  </div>
                )}

                <LabeledSwitch
                  label="Also set the Event Breaker buffer timeout"
                  checked={setStale}
                  onChange={setSetStale}
                  hint="staleChannelFlushMs — applied only to types that support it."
                />
                {setStale && (
                  <div className="form-grid">
                    <label className="field">
                      <Text variant="body-sm-semibold">Buffer timeout (ms)</Text>
                      <TextField
                        aria-label="Event Breaker buffer timeout in milliseconds"
                        placeholder="e.g. 10000"
                        value={staleText}
                        onChange={setStaleText}
                      />
                      {staleError && <Text color="attention">{staleError}</Text>}
                    </label>
                  </div>
                )}

                <Text as="h3" variant="heading-sm">
                  3. After applying
                </Text>
                <LabeledSwitch
                  label="Commit the worker group"
                  checked={commitAfter}
                  onChange={(v) => {
                    setCommitAfter(v);
                    if (!v) setDeployAfter(false);
                  }}
                  hint="Without a commit, the change will not persist in the group's config."
                />
                {commitAfter && (
                  <>
                    <div className="form-grid">
                      <label className="field">
                        <Text variant="body-sm-semibold">Commit message</Text>
                        <TextField
                          aria-label="Commit message"
                          placeholder="Bulk Event Breaker ruleset update"
                          value={commitMessage}
                          onChange={setCommitMessage}
                        />
                      </label>
                    </div>
                    <LabeledSwitch
                      label="Deploy the group after committing"
                      checked={deployAfter}
                      onChange={setDeployAfter}
                    />
                  </>
                )}

                <div className="wf-actions">
                  <Button variant="primary" disabled={!canPreview} onClick={() => setView('preview')}>
                    Preview changes
                  </Button>
                  {selection.size > 0 && (
                    <Text variant="body-sm-normal" color="subtle">
                      {planSummary.changed} of {selection.size} selected source
                      {selection.size === 1 ? '' : 's'} would change.
                    </Text>
                  )}
                  {dryRun && (
                    <Pill appearance="info" variant="muted">
                      Dry run enabled
                    </Pill>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Post-batch commit/deploy outcome banner. */
function CommitDeployAlert({
  deploy,
  groupLabel,
}: {
  deploy: DeployStatus | null;
  groupLabel: string;
}) {
  if (!deploy?.attempted) return null;
  const where = `worker group “${groupLabel}”`;
  if (deploy.error) {
    return (
      <Alert appearance="danger" title={deploy.committed ? 'Deploy failed' : 'Commit failed'}>
        {deploy.error} The ruleset changes were written, but {where} was{' '}
        {deploy.committed ? 'committed and not deployed' : 'not committed'}; finish it manually.
      </Alert>
    );
  }
  if (deploy.note) {
    return (
      <Alert appearance="info" title="Nothing to commit">
        {deploy.note}
      </Alert>
    );
  }
  if (deploy.deployRequested && deploy.deployed) {
    return (
      <Alert appearance="info" title="Committed and deployed">
        Committed and deployed the changes to {where}.
      </Alert>
    );
  }
  return (
    <Alert appearance="info" title="Committed">
      Committed the changes to {where}. Deploy the group to activate them.
    </Alert>
  );
}
