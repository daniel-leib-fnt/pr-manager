import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, Subject, firstValueFrom } from 'rxjs';

export type Group = 'needs_me' | 'working' | 'queued' | 'blocked' | 'out_of_date' | 'waiting' | 'ignored' | 'closed';

export interface Pr {
  id: number;
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  role: 'own' | 'review';
  head_ref: string;
  base_ref: string;
  is_draft: number;
  state: 'open' | 'merged' | 'closed' | 'dropped';
  check_state: string | null;
  summary: string | null;
  worktree: string | null;
  session_id: string | null;
  paused: number;
  blocked: string | null;
  agent_running: number;
  review_state: 'none' | 'draft' | 'submitted';
  review_verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | null;
  review_body: string | null;
  reviewed_sha: string | null;
  review_out_of_date: number;
  ignored: number;
  /** GitHub's last update of the PR, ISO 8601. */
  gh_updated_at: string;
  group: Group;
  running: boolean;
  batch: 'none' | 'open' | 'closable';
  waitingForBuild: boolean;
  counts: { proposals: number; questions: number; pending: number; findings: number };
}

export interface Comment {
  id: number;
  kind: 'thread' | 'issue_comment' | 'review_body' | 'ci' | 'instruction';
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  url: string | null;
  state: 'new' | 'fixed' | 'proposal' | 'accepted' | 'skipped' | 'done' | 'gone';
  proposal: string | null;
  reply_draft: string | null;
  skip_reason: string | null;
  auto: number;
  note: string | null;
  updated_at: string;
}

export interface Question {
  id: number;
  comment_id: number | null;
  question: string;
  options: string | null;
  answer: string | null;
  state: 'open' | 'answered' | 'sent';
}

export interface Finding {
  id: number;
  kind: 'finding' | 'thread_reply';
  path: string | null;
  line: number | null;
  in_diff: number;
  body: string;
  state: 'draft' | 'skipped' | 'submitted';
  url: string | null;
}

export interface WorkItem {
  id: number;
  kind: string;
  state: 'queued' | 'in_progress' | 'done' | 'failed';
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface PrDetail {
  pr: Pr;
  comments: Comment[];
  questions: Question[];
  findings: Finding[];
  work: WorkItem[];
}

export interface Setting {
  key: string;
  group: string;
  label: string;
  help: string | null;
  type: 'number' | 'boolean' | 'string' | 'text' | 'list' | 'enum' | 'multi' | 'days';
  options: { value: string; label: string }[] | null;
  value: unknown;
  source: 'override' | 'nix' | 'default';
  nixValue: unknown;
  defaultValue: unknown;
}

export interface NixOnly {
  label: string;
  value: string;
  option: string;
}

export interface DeniedCall {
  at: string;
  pr: string;
  tool: string;
  detail: string;
  rule: string;
}

export interface LiveEvent {
  type: 'pr' | 'message' | 'denied';
  prId: number;
  message?: unknown;
  tool?: string;
  detail?: string;
  at?: string;
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  /** Bumped whenever any PR changes; views reload on change. */
  readonly version = signal(0);
  readonly connected = signal(false);
  private readonly live = new Subject<LiveEvent>();
  readonly events: Observable<LiveEvent> = this.live.asObservable();

  constructor() {
    this.connect();
  }

  private connect() {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      this.connected.set(true);
      this.version.update((v) => v + 1);
    };
    source.onerror = () => this.connected.set(false);
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as LiveEvent;
      if (event.type === 'pr') this.version.update((v) => v + 1);
      this.live.next(event);
    };
  }

  prs() {
    return firstValueFrom(this.http.get<{ prs: Pr[]; lastPoll: string | null }>('/api/prs'));
  }

  pr(id: number) {
    return firstValueFrom(this.http.get<PrDetail>(`/api/prs/${id}`));
  }

  transcript(id: number) {
    return firstValueFrom(this.http.get<unknown[]>(`/api/prs/${id}/transcript`));
  }

  action(id: number, name: string, body: unknown = {}) {
    return firstValueFrom(this.http.post<unknown>(`/api/prs/${id}/${name}`, body));
  }

  settings() {
    return firstValueFrom(this.http.get<{ settings: Setting[]; nixOnly: NixOnly[]; denied: DeniedCall[] }>('/api/settings'));
  }

  saveSettings(values: Record<string, unknown>) {
    return firstValueFrom(this.http.put<{ settings: Setting[] }>('/api/settings', values));
  }

  resetSetting(key: string) {
    return firstValueFrom(this.http.delete<{ settings: Setting[] }>(`/api/settings/${key}`));
  }

  pollNow() {
    return firstValueFrom(this.http.post<unknown>('/api/poll', {}));
  }
}
