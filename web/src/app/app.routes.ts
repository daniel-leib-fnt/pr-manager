import type { Routes } from '@angular/router';
import { Overview } from './overview';
import { PrPage } from './pr-page';
import { SettingsPage } from './settings';

export const routes: Routes = [
  { path: '', component: Overview, title: 'pr-manager' },
  { path: 'pr/:id', component: PrPage, title: 'pr-manager' },
  { path: 'settings', component: SettingsPage, title: 'pr-manager settings' },
  { path: '**', redirectTo: '' },
];
