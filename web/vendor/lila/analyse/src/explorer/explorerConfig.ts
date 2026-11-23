import { opposite } from '@lichess-org/chessground/util';
import { h, type VNode } from 'snabbdom';

import { myUsername, type Prop, prop } from 'lib';
import { capitalize } from 'lib/game';
import perfIcons from 'lib/game/perfIcons';
import { licon } from 'lib/licon';
import { storedProp, storedJsonProp, type StoredProp, storedStringProp } from 'lib/storage';
import { snabDialog, bind, dataIcon, icon, onInsert } from 'lib/view';
import { userComplete } from 'lib/view/userComplete';

import type AnalyseCtrl from '../ctrl';
import { ucfirst } from './explorerUtil';
import { complete } from 'lib/view/complete';

import type { ExplorerDb, ExplorerSpeed, ExplorerMode, ExplorerPlayerChoice } from './interfaces';

const allSpeeds: ExplorerSpeed[] = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
const allModes: ExplorerMode[] = ['casual', 'rated'];
const allRatings = [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
const minYear = 1952;

type Month = string;
type ByDbSetting = {
  since: StoredProp<Month>;
  until: StoredProp<Month>;
};
type ByDbSettings = Record<ExplorerDb, ByDbSetting>;

export interface ExplorerConfigData {
  open: Prop<boolean>;
  db: StoredProp<ExplorerDb>;
  rating: Prop<number[]>;
  speed: Prop<ExplorerSpeed[]>;
  mode: Prop<ExplorerMode[]>;
  byDbData: ByDbSettings;
  playerName: {
    value: StoredProp<string>;
    previous: Prop<string[]>;
  };
  color: StoredProp<Color>;
  byDb(): ByDbSetting;
}

export class ExplorerConfigCtrl {
  data: ExplorerConfigData;
  allDbs: ExplorerDb[] = ['lichess', 'player'];
  myName?: string;
  participants: (string | undefined)[];

  constructor(
    readonly root: AnalyseCtrl,
    readonly variant: VariantKey,
    readonly onClose: () => void,
    previous?: ExplorerConfigCtrl,
  ) {
    this.myName = myUsername();
    this.participants = [root.data.player.user?.username, root.data.opponent.user?.username].filter(
      name => name && name !== this.myName,
    );
    if (variant === 'standard') this.allDbs.unshift('masters');
    if (variant === 'standard' && root.opts.explorer.outpost) this.allDbs.splice(1, 0, 'reference');
    const byDbData = {} as ByDbSettings;
    for (const db of this.allDbs) {
      byDbData[db] = {
        since: storedStringProp('analyse.explorer.since-2.' + db, ''),
        until: storedStringProp('analyse.explorer.until-2.' + db, ''),
      };
    }
    const prevData = previous?.data;
    this.data = {
      open: prevData?.open || prop(false),
      db: storedProp<ExplorerDb>('explorer.db2.' + variant, this.allDbs[0], str => str as ExplorerDb),
      rating: storedJsonProp('analyse.explorer.rating', () => allRatings.slice(1)),
      speed: storedJsonProp<ExplorerSpeed[]>('explorer.speed', () => allSpeeds.slice(1)),
      mode: storedJsonProp<ExplorerMode[]>('explorer.mode', () => allModes),
      byDbData,
      playerName: {
        value: storedStringProp('analyse.explorer.player.name', this.myName || ''),
        previous: storedJsonProp<string[]>('explorer.player.name.previous', () => []),
      },
      color: storedProp<Color>('analyse.explorer.player.color', root.bottomColor(), str => str as Color),
      byDb() {
        return this.byDbData[this.db()] || this.byDbData.lichess;
      },
    };
  }

  selectPlayer = (name?: string) => {
    name = name === 'me' ? this.myName : name;
    if (!name) return;
    if (name === name.toLowerCase()) {
      /* If the user provides a lowercase version of a username that already
         exists in the personal opening explorer, don't make a new button and instead
         just use the existing one. */
      name =
        [
          ...this.data.playerName.previous(),
          this.data.playerName.value(),
          this.myName,
          ...this.participants,
        ].find(x => x?.toLowerCase() === name!.toLowerCase()) ?? name;
    }
    if (name !== this.myName && !this.participants.includes(name)) {
      const previous = this.data.playerName.previous().filter(n => n !== name);
      previous.unshift(name);
      this.data.playerName.previous(previous.slice(0, 20));
    }
    this.data.db('player');
    this.data.playerName.value(name);
  };

  removePlayer = (name?: string) => {
    if (!name) return;
    const previous = this.data.playerName.previous().filter(n => n !== name);
    this.data.playerName.previous(previous);

    if (this.data.playerName.value() === name) this.data.playerName.value('');
  };

  toggleMany =
    <T>(c: Prop<T[]>) =>
    (value: T) => {
      if (!c().includes(value)) c(c().concat([value]));
      else if (c().length > 1) c(c().filter(v => v !== value));
    };

  toggleColor = () => this.data.color(opposite(this.data.color()));

  toggleOpen = () => {
    this.data.open(!this.data.open());
    if (!this.data.open()) {
      if (this.data.db() === 'player' && !this.data.playerName.value()) this.data.db('lichess');
      this.onClose();
    }
  };

  fullHouse = () =>
    this.data.byDb().since() <= `${minYear}-01` &&
    (!this.data.byDb().until() || new Date().toISOString().slice(0, 7) <= this.data.byDb().until()) &&
    (this.data.db() === 'masters' ||
      this.data.db() === 'reference' ||
      this.data.speed().length === allSpeeds.length) &&
    (this.data.db() !== 'lichess' || this.data.rating().length === allRatings.length) &&
    (this.data.db() !== 'player' || this.data.mode().length === allModes.length);
}

export const view = (ctrl: ExplorerConfigCtrl): VNode[] => [
  ctrl.data.db() === 'masters' || ctrl.data.db() === 'reference'
    ? masterDb(ctrl)
    : ctrl.data.db() === 'lichess'
      ? lichessDb(ctrl)
      : playerDb(ctrl),
  h(
    'section.save',
    h(
      'button.button.button-green.text',
      { attrs: dataIcon(licon.Checkmark), hook: bind('click', ctrl.toggleOpen) },
      i18n.site.allSet,
    ),
  ),
];

const selectText = 'Select a Lichess player';

// outpost: player specs are Outpost profiles or accounts; show their display names
const outpostOf = (ctrl: ExplorerConfigCtrl) => ctrl.root.opts.explorer.outpost;
const playerLabel = (ctrl: ExplorerConfigCtrl, name: string) =>
  outpostOf(ctrl)?.playerLabel(name) ?? name;

const playerDb = (ctrl: ExplorerConfigCtrl) => {
  const name = ctrl.data.playerName.value();
  const select = outpostOf(ctrl) ? 'Select a player' : selectText;
  return h('div.player-db', [
    h('section.name', [
      h('label', i18n.site.player),
      h('div', [
        h(
          'div.choices',
          h(
            `button.player-name${name ? '.active' : ''}`,
            {
              hook: bind('click', () => playerModal(ctrl)),
              attrs: name ? { title: select } : undefined,
            },
            name ? playerLabel(ctrl, name) : select,
          ),
        ),
        h(
          'button.button-link.text.color',
          {
            attrs: dataIcon(licon.ChasingArrows),
            hook: bind('click', ctrl.toggleColor, ctrl.root.redraw),
          },
          ` ${i18n.site[`as${capitalize(ctrl.data.color())}`]}`,
        ),
      ]),
    ]),
    speedSection(ctrl),
    modeSection(ctrl),
    monthSection(ctrl),
  ]);
};

const masterDb = (ctrl: ExplorerConfigCtrl) =>
  h('div', [
    h('section.date', [
      h('label', [i18n.site.since, yearInput(ctrl.data.byDb().since, () => '', ctrl.root.redraw)]),
      h('label', [
        i18n.site.until,
        yearInput(ctrl.data.byDb().until, ctrl.data.byDb().since, ctrl.root.redraw),
      ]),
    ]),
  ]);

const radioButton =
  <T>(ctrl: ExplorerConfigCtrl, storage: Prop<T[]>, render: (t: T) => VNode | string) =>
  (v: T) =>
    h(
      'button',
      {
        attrs: { 'aria-pressed': `${storage().includes(v)}`, title: ucfirst(String(v)) },
        hook: bind('click', _ => ctrl.toggleMany(storage)(v), ctrl.root.redraw),
      },
      render(v),
    );

const lichessDb = (ctrl: ExplorerConfigCtrl) =>
  h('div', [
    speedSection(ctrl),
    h('section.rating', [
      h('label', i18n.site.averageElo),
      h('div.choices', allRatings.map(radioButton(ctrl, ctrl.data.rating, r => r.toString()))),
    ]),
    monthSection(ctrl),
  ]);

const speedSection = (ctrl: ExplorerConfigCtrl) =>
  h('section.speed', [
    h('label', i18n.site.timeControl),
    h('div.choices', allSpeeds.map(radioButton(ctrl, ctrl.data.speed, s => icon(perfIcons[s])()))),
  ]);

const modeSection = (ctrl: ExplorerConfigCtrl) =>
  h('section.mode', [
    h('label', i18n.site.mode),
    h('div.choices', allModes.map(radioButton(ctrl, ctrl.data.mode, m => i18n.site[m]))),
  ]);

const monthInput = (prop: StoredProp<Month>, after: () => Month, redraw: Redraw) => {
  const validateRange = (input: HTMLInputElement) =>
    input.setCustomValidity(!input.value || after() <= input.value ? '' : 'Invalid date range');
  const max = new Date().toISOString().slice(0, 7);
  return h('input', {
    key: after() ? 'until-month' : 'since-month',
    attrs: {
      type: 'month',
      title: `Insert year and month in YYYY-MM format starting from ${minYear}-01`,
      pattern: '^(19|20)[0-9]{2}-(0[1-9]|1[012])$',
      placeholder: 'YYYY-MM',
      min: `${minYear}-01`,
      max,
      value: prop() > max ? max : prop(),
    },
    hook: {
      ...onInsert<HTMLInputElement>(input => {
        validateRange(input);
        input.addEventListener('change', e => {
          const input = e.target as HTMLInputElement;
          input.setCustomValidity('');
          if (input.checkValidity()) {
            validateRange(input);
            prop(input.value);
            redraw();
          }
        });
      }),
      update: (_, vnode) => validateRange(vnode.elm as HTMLInputElement),
    },
  });
};

const yearInput = (prop: StoredProp<Month>, after: () => Month, redraw: Redraw) => {
  const validateRange = (input: HTMLInputElement) =>
    input.setCustomValidity(!input.value || after().split('-')[0] <= input.value ? '' : 'Invalid date range');
  return h('input', {
    attrs: {
      key: after() ? 'until-year' : 'since-year',
      type: 'number',
      title: `Insert year in YYYY format starting from ${minYear}`,
      placeholder: 'YYYY',
      min: minYear,
      max: new Date().toISOString().slice(0, 4),
      value: prop().split('-')[0],
    },
    hook: {
      ...onInsert<HTMLInputElement>(input => {
        validateRange(input);
        input.addEventListener('change', e => {
          const input = e.target as HTMLInputElement;
          input.setCustomValidity('');
          if (input.checkValidity()) {
            validateRange(input);
            prop(input.value ? `${input.value}-${after() ? '12' : '01'}` : '');
            redraw();
          }
        });
      }),
      update: (_, vnode) => validateRange(vnode.elm as HTMLInputElement),
    },
  });
};

const monthSection = (ctrl: ExplorerConfigCtrl) => {
  const db = ctrl.data.byDb();
  return h('section.date', [
    h('label', [i18n.site.since, monthInput(db.since, () => '', ctrl.root.redraw)]),
    h('label', [i18n.site.until, monthInput(db.until, db.since, ctrl.root.redraw)]),
  ]);
};

// outpost: complete against Outpost profiles and accounts instead of Lichess users
function outpostPlayerComplete(ctrl: ExplorerConfigCtrl, input: HTMLInputElement, onSelect: (spec: string) => void) {
  const outpost = outpostOf(ctrl)!;
  complete<ExplorerPlayerChoice>({
    input,
    minLength: 2,
    fetch: term => outpost.searchPlayers(term),
    render: c => {
      const el = document.createElement('span');
      el.className = 'complete-result';
      el.textContent = c.label;
      if (c.hint) {
        const hint = document.createElement('em');
        hint.textContent = ` ${c.hint}`;
        el.append(hint);
      }
      return el;
    },
    populate: c => c.label,
    onSelect: c => onSelect(c.spec),
  });
  setTimeout(() => input.focus());
}

const playerModal = (ctrl: ExplorerConfigCtrl) => {
  const nameToOptionalColor = (name?: string) => {
    if (!name) return '';
    else if (name === ctrl.myName) return '.button-green';
    else if (ctrl.data.playerName.previous().includes(name)) return '';
    return '.button-metal';
  };

  return snabDialog({
    closeButton: true,
    class: 'explorer__config__player__choice',
    show: true,
    modal: true,
    noScrollable: true,
    easyClose: 'clickOutside',
    render: (redraw, dlg) => {
      const onSelect = (name?: string) => {
        ctrl.selectPlayer(name);
        ctrl.root.redraw();
        dlg.close();
      };
      return [
        h('h2', outpostOf(ctrl) ? 'Player opening explorer' : 'Personal opening explorer'),
        h('div.input-wrapper', [
          h('input', {
            attrs: {
              placeholder: outpostOf(ctrl) ? 'Search profiles and accounts' : i18n.study.searchByUsername,
              spellcheck: 'false',
            },
            hook: onInsert<HTMLInputElement>(input =>
              outpostOf(ctrl)
                ? outpostPlayerComplete(ctrl, input, onSelect)
                : userComplete({ input, focus: true, tag: 'span', onSelect: v => onSelect(v.name) }),
            ),
          }),
        ]),
        h(
          'div.previous',
          [
            ...new Set([
              ...(ctrl.myName ? [ctrl.myName] : []),
              ...ctrl.participants,
              ...ctrl.data.playerName.previous(),
              ...(outpostOf(ctrl)?.suggestedPlayers().map(c => c.spec) ?? []),
            ]),
          ].map(name =>
            h('div', { key: name }, [
              h(
                `button.button${nameToOptionalColor(name)}`,
                { hook: bind('click', () => onSelect(name)) },
                playerLabel(ctrl, name),
              ),
              name && ctrl.data.playerName.previous().includes(name)
                ? h('button.remove', {
                    attrs: dataIcon(licon.X),
                    hook: bind('click', () => ctrl.removePlayer(name), redraw),
                  })
                : null,
            ]),
          ),
        ),
      ];
    },
  });
};
