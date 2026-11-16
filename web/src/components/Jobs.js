// Scheduled jobs (run by Neural; see server/src/jobs.ts): what runs when, how the last run went, its output,
// and Run now, Pause and Delete. Jobs are added by sessions with the add_job tool.
import { useEffect, useState } from 'preact/hooks'
import { html, api, ago, clock } from '../lib.js'
import { jobs, loadJobs } from '../store.js'

/** "08:00" today, "Tue 08:00" later. */
function when(iso) {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? clock(iso) : `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(iso)}`
}

export function JobsSection() {
  useEffect(() => {
    if (jobs.value === null) loadJobs()
  }, [])
  const list = jobs.value ?? []
  if (!list.length) return null
  return html`<section class="section" aria-labelledby="jobs-h">
    <div class="section-head"><span class="label" id="jobs-h">Scheduled jobs</span><span class="count">${list.length}</span><span class="rule"></span></div>
    <div class="jobs">${list.map(j => html`<${JobRow} j=${j} key=${j.name} />`)}</div>
  </section>`
}

function JobRow({ j }) {
  const [open, setOpen] = useState(false)
  const last = j.last_run
  const bad = ['failed', 'timeout', 'interrupted'].includes(last?.status)
  const state = !j.enabled ? 'paused' : last ? last.status : 'not run yet'
  const act = (method, path) => api(method, `/api/jobs/${encodeURIComponent(j.name)}${path}`).catch(e => alert(e.message))
  const since = last && ago(last.started_at)
  return html`<div class=${`job ${bad ? 'bad' : last?.status === 'ok' ? 'ok' : ''}`}>
    <button class="job-main" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class="job-name">${j.name}</span>
      <span class="job-state">${state}${j.failures_in_a_row > 1 ? ` · ${j.failures_in_a_row} in a row` : ''}</span>
      <span class="job-when">${j.schedule}${j.next_run_at ? ` · next ${when(j.next_run_at)}` : ''}</span>
    </button>
    ${open && html`<div class="job-detail">
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
