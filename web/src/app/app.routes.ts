import { Component } from '@angular/core';
import type { Routes } from '@angular/router';
import { PrPage } from './pr-page';
import { SettingsPage } from './settings';

/** The detail column before a PR is chosen; the PR list itself lives in the sidebar. */
@Component({
  selector: 'app-no-selection',
  template: `<p class="muted empty">Select a pull request on the left.</p>`,
})
class NoSelection {}

export const routes: Routes = [
  { path: '', component: NoSelection, title: 'pr-manager' },
  { path: 'pr/:id', component: PrPage, title: 'pr-manager' },
  { path: 'settings', component: SettingsPage, title: 'pr-manager settings' },
  { path: '**', redirectTo: '' },
];
