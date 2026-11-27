import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Draft } from '../pr-view';

/** The card "Instruction to the agent". The text lives in the page's draft, so it survives a tab switch and a reload. */
@Component({
  selector: 'app-instruction-box',
  imports: [FormsModule],
  host: { class: 'card panel' },
  template: `
    <h2>Instruction to the agent</h2>
    <textarea
      rows="3"
      aria-label="Instruction"
      placeholder="Tell the agent what to do on this PR"
      [(ngModel)]="draft().instruction"
      (ngModelChange)="changed.emit()"
      (keydown.control.enter)="submit()"
      (keydown.meta.enter)="submit()"
    ></textarea>
    <div class="send-row">
      <span>
        <span class="kbd">Ctrl</span>
        +
        <span class="kbd">Enter</span>
        sends
      </span>
      <button (click)="submit()" [disabled]="!draft().instruction.trim() || busy()">Send instruction</button>
    </div>
  `,
})
export class InstructionBox {
  readonly draft = input.required<Draft>();
  readonly busy = input.required<boolean>();
  /** The draft changed in place and has to be kept. */
  readonly changed = output<void>();
  readonly send = output<void>();

  protected submit() {
    if (this.draft().instruction.trim() && !this.busy()) this.send.emit();
  }
}
