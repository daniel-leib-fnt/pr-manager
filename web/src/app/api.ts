import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, Subject, firstValueFrom } from 'rxjs';
import type { DeniedCall, LiveEvent, NixOnly, PrDetail, PrSummary as Pr, Setting } from '../../../server/model';

export type {
  Group,
  Excerpt,
  SelfReview,
  Question,
  WorkItem,
  PrDetail,
  Setting,
  NixOnly,
  DeniedCall,
  LiveEvent,
  OwnPrSummary,
  ReviewPrSummary,
  PrSummary as Pr,
  CommentView as Comment,
  FindingView as Finding,
  ReviewThreadView as ReviewThread,
} from '../../../server/model';

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  /** Bumped whenever any PR changes; views reload on change. */
  readonly version = signal(0);
  readonly connected = signal(false);
  /** Time of the last GitHub poll, kept here because the top bar shows it and the PR list loads it. */
  readonly lastPoll = signal<string | null>(null);
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
