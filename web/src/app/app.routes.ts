import type { Routes } from '@angular/router';
import { Overview } from './overview';
import { PrPage } from './pr-page';

export const routes: Routes = [
  { path: '', component: Overview, title: 'pr-manager' },
  { path: 'pr/:id', component: PrPage, title: 'pr-manager' },
  { path: '**', redirectTo: '' },
];
