import type { TuneCatalog } from '../core/tunes';
import { t } from './l10n';

export function tuneLabel(catalog: TuneCatalog, index: number): string {
  const tune = catalog.tunes[index];
  return t('tune-position').replace('{0}', String(index + 1)).replace('{1}', String(catalog.tunes.length)) + ' · ' + (tune.title || t('untitled-tune'));
}

/** SPEC-DOC-01 / 03、A11Y-04 / 05：候选移动不提交，只有显式激活才切曲。 */
export class TunePicker {
  private readonly trigger = document.createElement('button');
  private readonly list = document.createElement('div');
  private catalog: TuneCatalog = { source: '', tunes: [], issues: [], initialBlocked: false };
  private selected: number | null = null;
  private candidate = 0;
  private revision = 0;
  /** 只读来源状态（SPEC-LIFE-04 / 06）：锁定切曲交互，旧谱仅供参考时不可切换曲目。 */
  private locked = false;

  constructor(private readonly root: HTMLElement, private readonly confirm: HTMLButtonElement, private readonly choose: (index: number) => void) {
    this.trigger.type = 'button';
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', 'tune-list');
    this.list.id = 'tune-list';
    this.list.role = 'listbox';
    this.list.tabIndex = 0;
    this.list.hidden = true;
    root.append(this.trigger, this.list);
    this.trigger.addEventListener('click', () => this.list.hidden ? this.open() : this.close(false));
    this.trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.open(); }
    });
    this.list.addEventListener('keydown', (event) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      switch (event.key) {
        case 'ArrowDown': this.candidate = Math.min(this.catalog.tunes.length - 1, this.candidate + 1); break;
        case 'ArrowUp': this.candidate = Math.max(0, this.candidate - 1); break;
        case 'Home': this.candidate = 0; break;
        case 'End': this.candidate = this.catalog.tunes.length - 1; break;
        case 'Enter':
        case ' ': if (!event.repeat) this.commit(this.candidate); break;
        case 'Escape': this.close(true); break;
        case 'Tab': this.close(false); return;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.markCandidate();
    });
    document.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Node && !root.contains(event.target)) this.close(false);
    });
    this.confirm.addEventListener('click', () => this.choose(0));
  }

  update(catalog: TuneCatalog, selected: number | null): void {
    const hadFocus = this.root.contains(document.activeElement) || document.activeElement === this.confirm;
    this.close(false);
    this.revision += 1;
    this.catalog = catalog;
    this.selected = selected;
    this.root.hidden = catalog.tunes.length <= 1;
    this.confirm.hidden = catalog.tunes.length !== 1 || selected !== null || !catalog.tunes[0].reliable;
    this.trigger.disabled = this.locked;
    this.confirm.disabled = this.locked;
    this.confirm.textContent = t('confirm-tune');
    const label = selected === null ? t('choose-tune') : tuneLabel(catalog, selected);
    this.trigger.textContent = label;
    this.trigger.title = label;
    this.list.setAttribute('aria-label', t('choose-tune'));
    this.list.replaceChildren();
    const revision = this.revision;
    for (const tune of catalog.tunes) {
      const item = document.createElement('div');
      item.id = `tune-option-${tune.index}`;
      item.role = 'option';
      item.setAttribute('aria-selected', String(tune.index === selected));
      item.setAttribute('aria-disabled', String(!tune.reliable));
      item.textContent = `${tune.index + 1} · X:${tune.id ?? t('missing-tune-id')} · ${tune.title || t('untitled-tune')}${tune.reliable ? '' : ` · ${t('structure-unreliable')}`}`;
      item.title = item.textContent;
      item.addEventListener('click', () => { if (revision === this.revision) this.commit(tune.index); });
      this.list.append(item);
    }
    if (hadFocus) {
      if (!this.root.hidden) this.trigger.focus();
      else if (!this.confirm.hidden) this.confirm.focus();
      else document.getElementById('score')?.focus();
    }
  }

  close(restoreFocus: boolean): void {
    const wasOpen = !this.list.hidden;
    this.list.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) this.trigger.focus();
  }

  /** 只读来源状态锁定（SPEC-LIFE-04 / 06）：禁止打开列表与提交；恢复后解锁。 */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.trigger.disabled = locked;
    this.confirm.disabled = locked;
    if (locked) this.close(false);
  }

  private open(): void {
    this.candidate = this.selected ?? 0;
    this.list.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.list.focus();
    this.markCandidate();
  }

  private markCandidate(): void {
    if (this.list.hidden) return;
    this.list.setAttribute('aria-activedescendant', `tune-option-${this.candidate}`);
    for (const [index, child] of [...this.list.children].entries()) child.classList.toggle('candidate', index === this.candidate);
    this.list.children[this.candidate]?.scrollIntoView({ block: 'nearest' });
  }

  private commit(index: number): void {
    if (!this.catalog.tunes[index]?.reliable) return;
    this.close(true);
    this.choose(index);
  }
}
