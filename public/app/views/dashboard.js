/* =============================================================================
 * Reddably — Dashboard view (proof-of-life; first real view)
 * =============================================================================
 * Registers under #dashboard. Greets the user, shows live stat tiles, and a
 * recent-claims table. Uses only the UI kit + Reddably helpers — no direct
 * fetch(), no raw hex/px. Loaded after views.js.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // Statuses that count as "closed" — everything else is an open claim.
  var CLOSED_STATUSES = { paid: true, void: true };

  function greetingName() {
    var cu = R.currentUser;
    var user = (cu && cu.user) || cu;
    if (user && user.first_name) return Promise.resolve(user.first_name);
    // Fall back to a /me call if the shell hasn't cached it yet.
    return api.me().then(function (res) {
      R.currentUser = res;
      return (res && res.user && res.user.first_name) || '';
    }).catch(function () { return ''; });
  }

  function statTile(label, value) {
    return h('div', { class: 'card stat' }, [
      h('span', { class: 'stat__label' }, label),
      h('span', { class: 'stat__value' }, String(value)),
    ]);
  }

  function recentClaimsCard(claims) {
    if (!claims.length) {
      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('h2', { class: 'card__title' }, 'Recent claims'),
        ]),
        h('p', { class: 'empty-state__body', style: 'margin:0' },
          'No claims yet. Claims you create will appear here.'),
      ]);
    }

    var recent = claims.slice()
      .sort(function (a, b) {
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      })
      .slice(0, 8);

    var rows = recent.map(function (c) {
      var row = h('tr', {
        class: 'data-table__row--clickable',
        tabindex: '0',
        role: 'link',
      }, [
        h('td', null, [
          h('div', null, c.claim_number || '—'),
          h('div', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' },
            R.fmtDate(c.created_at)),
        ]),
        h('td', null, R.statusBadge(c.status)),
        h('td', { class: 'data-table__num' }, R.fmtMoney(c.billed_amount)),
      ]);
      function go() { R.navigate('claims/' + c.id); }
      row.addEventListener('click', go);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      return row;
    });

    var table = h('table', { class: 'data-table' }, [
      h('thead', null, h('tr', null, [
        h('th', null, 'Claim'),
        h('th', null, 'Status'),
        h('th', { class: 'data-table__num' }, 'Billed'),
      ])),
      h('tbody', null, rows),
    ]);

    return h('div', { class: 'card' }, [
      h('div', { class: 'card__header' }, [
        h('h2', { class: 'card__title' }, 'Recent claims'),
      ]),
      table,
    ]);
  }

  function render(root, firstName, clients, claims) {
    R.clear(root);

    var openCount = claims.filter(function (c) {
      return !CLOSED_STATUSES[c.status];
    }).length;
    var paidCount = claims.filter(function (c) {
      return c.status === 'paid';
    }).length;

    var greeting = firstName ? 'Welcome, ' + firstName : 'Welcome';

    var view = h('div', { class: 'view stack' }, [
      h('div', { class: 'page-header' }, [
        h('h1', { class: 'page-header__title' }, greeting),
      ]),
      h('div', { class: 'card-grid' }, [
        statTile('Total clients', clients.length),
        statTile('Open claims', openCount),
        statTile('Paid claims', paidCount),
      ]),
      recentClaimsCard(claims),
    ]);

    root.appendChild(view);
  }

  function mount(root) {
    R.renderLoading(root);

    function load() {
      R.renderLoading(root);
      Promise.all([
        greetingName(),
        api.clients.list(),
        api.claims.list(),
      ]).then(function (results) {
        var firstName = results[0] || '';
        var clients = (results[1] && results[1].clients) || [];
        var claims = (results[2] && results[2].claims) || [];
        render(root, firstName, clients, claims);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    load();
  }

  R.registerView('dashboard', mount);
})(window, document);
