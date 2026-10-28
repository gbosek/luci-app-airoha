// SPDX-License-Identifier: Apache-2.0

'use strict';
'require dom';
'require poll';
'require ui';
'require view.status.clients.common as common';

/*
 * Devices - one row per client, with its upload/download rate, session total
 * traffic and connection count.
 *
 * "This phone used 300 MB" says nothing about whether it went to the internet
 * (which costs upstream bandwidth) or stayed inside the LAN (which does not);
 * the upload/download columns answer the question that matters. The probe still
 * computes the LAN half of every flow, but the table no longer shows it.
 *
 * Totals are session totals. conntrack accounting belongs to the flow, so when
 * a flow is reaped its byte count leaves this table with it - there is no
 * lifetime counter to read. The column header says so rather than implying a
 * precision the data does not have.
 *
 * The Signal column only exists on a device that owns radios (the probe
 * reports how many it saw); on a wireless-less box the column would be an
 * unbroken run of dashes.
 *
 * This is deliberately NOT a LuCI view module. L.require() instantiates every
 * class it loads, and instantiating a View takes over #view - spinner first,
 * then DOM.content() with the render result. Requiring three of those from the
 * tab frame meant three of them fought over #view, and the tab bar lost. A
 * plain class is inert on require(); clients.js mounts it into its pane.
 */

var SORT_KEYS = [ 'state', 'hostname', 'ipv4', 'ipv6', 'mac', 'network', 'signal', 'up', 'down', 'total', 'conns', 'last' ];
var SORT_STORAGE = 'clients.devices.sort';
var WIDTH_STORAGE = 'clients.devices.widths';

/* A column never shrinks below this; below it a header label would clip into
 * the neighbour column's drag handle. */
var MIN_COL_PX = 48;

return L.Class.extend({
	store: null,
	clients: null,
	oui: null,
	sort: { key: 'state', desc: true },
	activeAddresses: null,
	ip6Source: null,
	ip4Source: null,
	reserved4: null,

	load: function() {
		var self = this;

		this.store = common.createStore();
		this.restoreSort();

		return common.loadOUI().then(function(oui) {
			self.oui = oui;
			return self.store.loadHistory();
		}).then(function() {
			return self.store.fetchLeases();
		}).then(function() {
			return self.store.fetchSnapshot();
		});
	},

	/* ---------------- cells ---------------- */

	ipv4SourceOf: function(ip) {
		if (this.reserved4 && this.reserved4[ip])
			return 'static';

		return (this.ip4Source && this.ip4Source[ip]) || null;
	},

	addressCell: function(list, className, checkable) {
		if (!list.length)
			return '-';

		var family = (className == 'clients__ip6') ? 6 : 4;

		return E('div', {}, list.map(L.bind(function(ip) {
			/* Only ARP can prove an address is still in use, and ARP is IPv4: an
			 * IPv6 address is never marked expired just because it does not
			 * appear in a table that cannot describe it. */
			var stale = checkable && !this.activeAddresses[ip];
			var classes = [ className ];
			var source = (family == 6) ? (this.ip6Source[ip] || null) : this.ipv4SourceOf(ip);

			if (stale)
				classes.push('clients__stale');

			if (family == 4)
				classes.push('clients__ip4');

			if (source)
				classes.push('clients__ip' + family + '--' + source);

			return E('div', {
				'class': classes.join(' '),
				'title': common.sourceTitle(source) || (stale ? _('Expired') : null)
			}, (family == 6) ? common.ipv6Nodes(ip) : ip);
		}, this)));
	},

	hostnameCell: function(entry) {
		var name = E('span', {
			'class': 'clients__name',
			'title': entry.hostname || null
		}, entry.hostname || '-');
		var wrapper = E('span', { 'class': 'clients__hostwrap' }, name);

		if (this.oui && entry.mac) {
			try {
				this.oui.decorate(name, entry.mac, false);
			}
			catch (e) {
				L.error(e);
			}
		}

		return wrapper;
	},

	/* The online/offline capsule carries no inline text: a column of repeated
	 * words is noise, and the state is already encoded in the colour and the
	 * row's grey. The full word is a hover tooltip away, and the aria-label
	 * keeps it answerable to a screen reader. */
	stateCell: function(entry) {
		var label = entry.online ? _('Online') : _('Offline');

		return E('span', {
			'class': 'clients__state clients__state--' + (entry.online ? 'up' : 'down'),
			'role': 'img',
			'title': label,
			'aria-label': label
		});
	},

	/* Where the client sits, in one column: a wireless row says which SSID and
	 * band it associated with, a wired row says which VLAN its address arrived
	 * on. Those are two answers to the same question. */
	networkCell: function(entry) {
		var parts = [];

		if (entry.ssid) {
			parts.push(E('span', { 'class': 'clients__ssid', 'title': entry.ssid }, entry.ssid));

			if (entry.band)
				parts.push(E('span', {
					'class': 'clients__band clients__band--' + String(entry.band).replace('.', '')
				}, entry.band));
		}
		else if (entry.vlan != null) {
			parts.push(E('span', { 'class': 'clients__vlan' }, _('VLAN %d').format(entry.vlan)));
		}
		else {
			parts.push(E('span', { 'class': 'clients__muted' }, entry.wireless ? _('Wireless') : _('Wired')));
		}

		return E('div', { 'class': 'clients__net' }, parts);
	},

	signalCell: function(entry) {
		if (entry.signal == null)
			return E('span', { 'class': 'clients__muted' }, '-');

		var quality = Math.min(Math.max((entry.signal + 110) / 70 * 100, 0), 100);
		var icon;

		if (quality == 0)
			icon = 'signal-000-000.svg';
		else if (quality < 25)
			icon = 'signal-000-025.svg';
		else if (quality < 50)
			icon = 'signal-025-050.svg';
		else if (quality < 75)
			icon = 'signal-050-075.svg';
		else
			icon = 'signal-075-100.svg';

		var title = (entry.noise != null)
			? '%s: %d %s / %s: %d %s / %s %d'.format(
				_('Signal'), entry.signal, _('dBm'),
				_('Noise'), entry.noise, _('dBm'),
				_('SNR'), entry.signal - entry.noise)
			: '%s: %d %s'.format(_('Signal'), entry.signal, _('dBm'));

		return E('span', { 'class': 'clients__signal', 'title': title }, [
			E('img', { 'src': L.resource('icons/' + icon), 'class': 'clients__signal-icon', 'alt': '' }),
			String(entry.signal)
		]);
	},

	/* A device is worth showing traffic for while it has any live rate or any
	 * accumulated total; below that every per-direction cell reads '-' rather
	 * than a column of meaningless "0 B/s". */
	hasAnyTraffic: function(entry) {
		if (!entry || !entry.rate || !entry.total)
			return false;

		return !!(entry.rate.wanUp || entry.rate.wanDown || entry.total.wanUp || entry.total.wanDown);
	},

	/* One direction of the live rate. The column header ("Upload rate" /
	 * "Download rate") already names the direction, so the cell carries only
	 * the value - no arrow - and stays a single short number. */
	rateCell: function(entry, dir) {
		if (!this.hasAnyTraffic(entry))
			return E('span', { 'class': 'clients__muted' }, '-');

		return E('div', { 'class': 'clients__traffic-rate' }, [
			E('span', { 'class': 'clients__traffic-' + dir.toLowerCase() },
				common.formatRate(entry.rate['wan' + dir] || 0))
		]);
	},

	/* The session total keeps both directions in one cell, arrows included:
	 * it is deliberately quiet - a floor, not a lifetime figure - so giving it
	 * the same weight as the rates would invite the wrong reading. */
	totalCell: function(entry) {
		if (!this.hasAnyTraffic(entry))
			return E('span', { 'class': 'clients__muted' }, '-');

		return E('div', {
			'class': 'clients__traffic-total',
			'title': _('Traffic seen while this view was open. conntrack counters belong to a flow, so the figure is a floor, not a lifetime total.')
		}, [
			E('span', {}, '↑ ' + common.formatSize(entry.total.wanUp || 0)),
			E('span', {}, '↓ ' + common.formatSize(entry.total.wanDown || 0))
		]);
	},

	renderRow: function(entry) {
		var seen = entry.online
			? _('now')
			: (common.relativeTime(entry.last) || '-');

		return E('tr', { 'class': entry.online ? null : 'clients__offline' }, [
			E('td', {}, this.stateCell(entry)),
			E('td', { 'class': 'clients__host' }, this.hostnameCell(entry)),
			E('td', {}, this.addressCell(entry.ipv4, 'clients__addr', true)),
			E('td', {}, this.addressCell(entry.ipv6, 'clients__ip6', false)),
			E('td', { 'class': 'clients__addr' }, entry.mac || '-'),
			E('td', {}, this.networkCell(entry)),
			this.hasWifi ? E('td', {}, this.signalCell(entry)) : null,
			E('td', { 'class': 'clients__ctr' }, this.rateCell(entry, 'Up')),
			E('td', { 'class': 'clients__ctr' }, this.rateCell(entry, 'Down')),
			E('td', { 'class': 'clients__ctr' }, this.totalCell(entry)),
			E('td', { 'class': 'clients__ctr' }, common.formatCount(entry.conns)),
			E('td', { 'class': 'clients__seen', 'title': common.absoluteTime(entry.last) }, [
				E('div', { 'class': 'clients__seen-last' }, seen),
				entry.first ? E('div', { 'class': 'clients__seen-first' },
					_('first %s').format(common.relativeTime(entry.first) || common.absoluteTime(entry.first))) : null
			])
		]);
	},

	/* A sortable header: the whole cell is the control, so it also responds to
	 * Enter and Space and carries aria-sort for screen readers. The arrow is
	 * rendered only while the column is sorted: a permanent empty span would
	 * push every header label one arrow-width off its values, which is most
	 * visible on the single-number Connections column. */
	headerCell: function(label, key, className) {
		var active = (this.sort.key == key);
		var classes = [ className || '', active ? 'clients__sorted' : '' ];

		var cell = E('th', {
			'class': classes.join(' ').trim() || null,
			'role': 'button',
			'tabindex': '0',
			'data-key': key,
			'aria-sort': active ? (this.sort.desc ? 'descending' : 'ascending') : 'none',
			'title': _('Sort by %s').format(label),
			'click': ui.createHandlerFn(this, 'handleSort', key)
		}, [
			label,
			active ? E('span', { 'class': 'clients__arrow', 'aria-hidden': 'true' },
				this.sort.desc ? '▼' : '▲') : null
		]);

		cell.addEventListener('keydown', ui.createHandlerFn(this, 'handleSortKey', key));

		return cell;
	},

	/* Default column widths, one per column including Signal only when this
	 * box owns radios. The layout is fixed because automatic sizing picks the
	 * widest IPv6 hextet and pushes the counters out of the card; the drag
	 * handles let a viewer override each width, and the choice persists. */
	DEFAULT_WIDTHS_FULL: [ '3rem', '7.5rem', '7.5rem', '9.5rem', '9rem', '7.5rem',
		'4.75rem', '5.5rem', '5.5rem', '7.5rem', '5rem', '6.5rem' ],
	DEFAULT_WIDTHS_NOWIFI: [ '3rem', '7.5rem', '7.5rem', '9.5rem', '9rem', '7.5rem',
		'5.5rem', '5.5rem', '7.5rem', '5rem', '6.5rem' ],

	restoreWidths: function() {
		var defaults = this.hasWifi ? this.DEFAULT_WIDTHS_FULL : this.DEFAULT_WIDTHS_NOWIFI;
		var stored = null;

		try {
			stored = JSON.parse(window.localStorage.getItem(WIDTH_STORAGE) || 'null');
		}
		catch (e) {
			stored = null;
		}

		/* A stored row only fits the column count it was dragged on; anything
		 * else (an upgrade, a different box) falls back to the defaults. */
		this.widths = (Array.isArray(stored) && stored.length == defaults.length)
			? stored : defaults.slice();
	},

	saveWidths: function() {
		try {
			window.localStorage.setItem(WIDTH_STORAGE, JSON.stringify(this.widths));
		}
		catch (e) {
			/* Private mode / quota: the choice simply does not persist. */
		}
	},

	/* A drag handle at the right edge of every header cell. Pointer events
	 * keep the maths identical for mouse and touch; the handle swallows its
	 * own click so finishing a drag on it never sorts the column, and the
	 * live widths land in the colgroup, where the fixed layout applies them
	 * to every row at once. */
	attachResizers: function(headCells) {
		var self = this;
		var cols = this.colEls;

		headCells.forEach(function(cell, index) {
			var handle = E('span', { 'class': 'clients__resizer', 'aria-hidden': 'true' });

			handle.addEventListener('click', function(ev) { ev.stopPropagation(); });
			handle.addEventListener('pointerdown', function(ev) {
				ev.preventDefault();
				ev.stopPropagation();

				var startX = ev.clientX;
				var startW = cell.getBoundingClientRect().width;
				var moved = false;

				function onMove(e) {
					var width = Math.max(MIN_COL_PX, startW + e.clientX - startX);

					if (Math.abs(width - startW) > 2)
						moved = true;

					self.widths[index] = width + 'px';
					cols[index].style.width = width + 'px';
				}

				function onUp() {
					document.removeEventListener('pointermove', onMove);
					document.removeEventListener('pointerup', onUp);

					if (moved)
						self.saveWidths();
				}

				document.addEventListener('pointermove', onMove);
				document.addEventListener('pointerup', onUp);
			});

			cell.appendChild(handle);
		});
	},

	buildTable: function(clients) {
		var head = [
			this.headerCell(_('State'), 'state'),
			this.headerCell(_('Hostname'), 'hostname'),
			this.headerCell(_('IPv4 address'), 'ipv4'),
			this.headerCell(_('IPv6 address'), 'ipv6'),
			this.headerCell(_('MAC address'), 'mac'),
			this.headerCell(_('Network'), 'network')
		];

		if (this.hasWifi)
			head.push(this.headerCell(_('Signal'), 'signal'));

			head.push(
				/* Upload and download are separate columns, so each header names
				 * one direction and its cell is a bare number. Total keeps both
				 * arrows because it stacks ↑ and ↓ in one cell. All four
				 * counters are centred so each header sits over its value. */
				this.headerCell(_('Upload rate'), 'up', 'clients__ctr'),
				this.headerCell(_('Download rate'), 'down', 'clients__ctr'),
				this.headerCell(_('Total traffic') + ' (↑ / ↓)', 'total', 'clients__ctr'),
				this.headerCell(_('Connections'), 'conns', 'clients__ctr'),
				this.headerCell(_('Last seen'), 'last')
			);

		this.restoreWidths();

		var colgroup = E('colgroup', {}, this.widths.map(function(width) {
			return E('col', { 'style': 'width:' + width });
		}));

		/* childNodes is live, but dom.content() rebuilds the table every poll;
		 * the copy is taken while the nodes exist. */
		this.colEls = Array.prototype.slice.call(colgroup.childNodes);
		this.attachResizers(head);

		this.activeAddresses = Object.create(null);
		(this.store.state.arp || []).forEach(L.bind(function(neighbour) {
			this.activeAddresses[neighbour.ip] = true;
		}, this));

		var body = clients.length
			? clients.map(L.bind(this.renderRow, this))
			: [ E('tr', {}, [
				E('td', { 'colspan': head.length, 'class': 'clients__empty' },
					E('em', {}, _('No clients are online right now.')))
			]) ];

		/* Fixed widths, because automatic layout sizes the IPv6 column by its
		 * widest hextet and then pushes the counters out of the card. */
		return E('table', { 'class': 'clients' }, [
			colgroup,
			E('thead', {}, E('tr', {}, head)),
			E('tbody', {}, body)
		]);
	},

	/* Sorts from the cached client list, so the order survives the refresh
	 * without re-reading anything. Entries with no value for the active column
	 * always sink to the bottom, whichever direction is selected. */
	sortEntries: function(clients) {
		var sort = this.sort;

		clients.sort(function(a, b) {
			var av = common.sortValue(a, sort.key);
			var bv = common.sortValue(b, sort.key);
			var cmp;

			if (av == null || bv == null) {
				if (av == null && bv == null)
					cmp = 0;
				else
					return (av == null) ? 1 : -1;
			}
			else if (typeof av == 'number' && typeof bv == 'number') {
				cmp = av - bv;
			}
			else {
				cmp = L.naturalCompare(String(av), String(bv));
			}

			if (cmp != 0)
				return sort.desc ? -cmp : cmp;

			var at = a.total.up + a.total.down;
			var bt = b.total.up + b.total.down;

			if (at != bt)
				return bt - at;

			return L.naturalCompare(a.hostname || a.mac || a.id, b.hostname || b.mac || b.id);
		});
	},

	handleSort: function(key, ev) {
		if (ev && ev.preventDefault)
			ev.preventDefault();

		if (this.sort.key == key)
			this.sort.desc = !this.sort.desc;
		else
			this.sort = { key: key, desc: (key == 'state') };

		this.saveSort();
		this.updateTable();

		var cell = this.table.querySelector('th[data-key="' + key + '"]');

		if (cell)
			cell.focus();
	},

	handleSortKey: function(key, ev) {
		if (ev.key != 'Enter' && ev.key != ' ')
			return;

		ev.preventDefault();
		this.handleSort(key);
	},

	saveSort: function() {
		try {
			window.localStorage.setItem(SORT_STORAGE, JSON.stringify(this.sort));
		}
		catch (e) {
			/* Private mode / quota: the choice simply does not persist. */
		}
	},

	restoreSort: function() {
		var stored = null;

		try {
			stored = JSON.parse(window.localStorage.getItem(SORT_STORAGE) || 'null');
		}
		catch (e) {
			stored = null;
		}

		if (stored && SORT_KEYS.indexOf(stored.key) >= 0)
			this.sort = { key: stored.key, desc: stored.desc === true };
		else
			this.sort = { key: 'state', desc: true };
	},

	updateTable: function() {
		this.ip6Source = Object.create(null);
		this.ip4Source = Object.create(null);
		this.store.state.ip6Source = this.ip6Source;
		this.store.state.ip4Source = this.ip4Source;

		this.hasWifi = ((this.store.state.wifiRadios || 0) > 0);
		var clients = this.store.clients();

		this.reserved4 = this.store.state.reserved4;
		this.clients = clients;
		this.sortEntries(clients);

		var online = 0, total = clients.length;

		clients.forEach(function(entry) {
			if (entry.online)
				online++;
		});

		var table = this.buildTable(clients);

		/* childNodes is a live NodeList: copy it before dom.content() moves the
		 * nodes out of the freshly built table. */
		dom.content(this.table, Array.prototype.slice.call(table.childNodes));
		this.count.textContent = _('%d online / %d total').format(online, total);
	},

	render: function() {
		var self = this;

		common.ensureStylesheet();

		this.count = E('span', { 'class': 'clients-count' }, '-');
		this.table = E('table', { 'class': 'clients' });

		this.updateTable();

		/* Nothing in this build listens for visibilitychange, so a page left in a
		 * background tab would keep paying for a conntrack walk every interval. */
		poll.add(L.bind(function() {
			var jobs;

			/* hidden covers the background tab and the inactive tab case. */
			if (document.hidden || this.hidden)
				return Promise.resolve();

			jobs = [ this.store.fetchSnapshot() ];

			if ((Date.now() - this.store.lastLeaseLoad) >= common.LEASE_INTERVAL * 1000)
				jobs.push(this.store.fetchLeases());

			if ((Date.now() - this.store.lastHistoryLoad) >= common.HISTORY_INTERVAL * 1000)
				jobs.push(this.store.loadHistory());

			return Promise.all(jobs).then(function() {
				self.updateTable();
			}).catch(function(error) {
				/* A failing probe must not stop the poll: the next tick retries and
				 * the page keeps the last known rows on screen. */
				L.error(error);
			});
		}, this), common.SAMPLE_INTERVAL);

		return E('div', { 'class': 'clients-pane' }, [
		E('div', { 'class': 'cbi-map-descr' },
			_('Every station this device can see, with its addresses, the network it sits on, and its WAN traffic.')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [
					_('Known clients'),
					E('span', { 'class': 'pull-right clients-tags' }, this.count)
				]),
				E('div', { 'class': 'clients-wrap' }, this.table),
				E('div', { 'class': 'clients-footer' }, [
					E('div', { 'class': 'clients-footer__legend' }, [
						E('span', { 'class': 'clients-legend clients-legend--ip4-dynamic' }, 'DHCP'),
						E('span', { 'class': 'clients-legend clients-legend--ip4-static' }, _('Static lease')),
						E('span', { 'class': 'clients-legend clients-legend--ip4-manual' }, _('Manual')),
						E('span', { 'class': 'clients-legend clients-legend--ip6-dhcpv6' }, 'DHCPv6'),
					E('span', { 'class': 'clients-legend clients-legend--ip6-slaac' }, 'SLAAC'),
					E('span', { 'class': 'clients-footer__text' },
						_('addresses are coloured by who assigned them'))
				]),
				E('p', { 'class': 'clients-note' },
					_('WAN counts traffic to addresses outside this network; traffic between local hosts is not shown. Rates are differentiated from kernel conntrack counters, which keep counting for hardware-offloaded flows.')),
				E('p', { 'class': 'clients-note' },
					_('The subtotals are what this view has seen since it was opened. conntrack counters belong to a flow, so a flow that ends takes its bytes with it - treat the figure as a floor, not a lifetime total.'))
			])
			])
		]);
	}
});
