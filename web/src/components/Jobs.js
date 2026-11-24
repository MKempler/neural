// Scheduled jobs (run by Neural; see server/src/jobs.ts): what runs when, how the last run went, its output,
// and Run now, Pause and Delete. Jobs are added by sessions with the add_job tool.
import { useEffect, useState } from 'preact/hooks'
import { html, api, ago, when } from '../lib.js'
import { jobs, loadJobs } from '../store.js'

export function JobsSection() {
  useEffect(() => {
    if (jobs.value === null) loadJobs()
  }, [])
  const list = jobs.value ?? []
  if (!list.length) return null
  const active = list.filter(j => j.enabled && !j.done)
  const paused = list.filter(j => !j.enabled && !j.done)
  const done = list.filter(j => j.done)
  const rows = js => html`<div class="jobs">${js.map(j => html`<${JobRow} j=${j} key=${j.name} />`)}</div>`
  return html`<section class="section" aria-labelledby="jobs-h">
    <div class="section-head"><span class="label" id="jobs-h">Scheduled jobs</span><span class="count">${list.length}</span><span class="rule"></span></div>
    ${active.length > 0 && html`<div class="job-group"><div class="job-group-h">Active</div>${rows(active)}</div>`}
    ${paused.length > 0 && html`<div class="job-group"><div class="job-group-h">Paused</div>${rows(paused)}</div>`}
    ${done.length > 0 && html`<details class="job-group"><summary class="job-group-h">Done · ${done.length}</summary>${rows(done)}</details>`}
  </section>`
}

function JobRow({ j }) {
  const [open, setOpen] = useState(false)
  const last = j.last_run
  const bad = ['failed', 'timeout', 'interrupted'].includes(last?.status)
  const state = last?.status === 'running' ? 'running' : bad ? `${last.status}${j.failures_in_a_row > 1 ? ` · ${j.failures_in_a_row} in a row` : ''}` : ''
  const act = (method, path) => api(method, `/api/jobs/${encodeURIComponent(j.name)}${path}`).catch(e => alert(e.message))
  const since = last && ago(last.started_at)
  const meta = [j.when ?? j.schedule]
  if (j.next_run_at && !j.done) meta.push(`next ${when(j.next_run_at)}`)
  meta.push(last ? `last run ${when(last.started_at)}${bad ? '' : ` · ${last.status}`}` : 'not run yet')
  return html`<div class=${`job${bad ? ' bad' : ''}`}>
    <button class="job-main" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class="job-name">${j.name}</span>
      <span class="job-state">${state}</span>
      <span class="job-when">${meta.join(' · ')}</span>
    </button>
    ${open && html`<div class="job-detail">
      <div class="job-sched">Schedule: <code>${j.schedule}</code></div>
      <div class="job-what">${j.command ?? `Message to ${j.session}: ${j.prompt}`}</div>
      ${last && html`<div class="job-last">Last run ${since === 'now' ? 'just now' : `${since} ago`}${last.exit_code != null ? ` · exit ${last.exit_code}` : ''}</div>`}
      ${last?.output_tail && html`<pre class="detail">${last.output_tail}</pre>`}
      <div class="actions">
        <button class="btn sm" onClick=${() => act('POST', '/run')}>Run now</button>
        <button class="btn sm" onClick=${() => act('POST', j.enabled ? '/pause' : '/resume')}>${j.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn sm danger" onClick=${() => confirm(`Delete the job ${j.name}?`) && act('DELETE', '')}>Delete</button>
      </div>
    </div>`}
  </div>`
}
