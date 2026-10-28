// SPDX-License-Identifier: Apache-2.0

'use strict';
'require dom';
'require poll';
'require ui';
'require view.status.clients.common as common';

/*
 * Overview - the totals, and the trend that makes them interpretable.
 *
 * The chart is drawn as inline SVG rather than pulled from a charting library.
 * A router image has no room for one, and the shape needed here is two lines
 * with a shared axis: a library would add more code than the drawing does.
 *
 * The series comes from the collector, in the snapshot the page already reads:
 * one point per sampling pass, kept in /tmp so it survives a page reload and is
 * already there when the page opens. It used to be built here, which meant the
 * chart started at "whenever this page was opened" and a reload threw the
 * history away. Only the fallback path - no cache, collector stopped - still
 * accumulates points in memory while the page is open.
 *
 * The totals come from conntrack, so they are floors rather than lifetime
 * figures. The footnote under the chart says that once instead of repeating it
 * in every tile.
 *
 * This is deliberately NOT a LuCI view module. L.require() instantiates every
 * class it loads, and instantiating a View takes over #view - spinner first,
 * then DOM.content() with the render result. Requiring three of those from the
 * tab frame meant three of them fought over #view, and the tab bar lost. A
 * plain class is inert on require(); clients.js mounts it into its pane.
 */

var WINDOWS = [
	{ label: _('Last 5 minutes'), minutes: 5 },
	{ label: _('Last 10 minutes'), minutes: 10 },
	{ label: _('Last 25 minutes'), minutes: 25 }
];

var TYPES = [
	{ value: 'total', label: _('Total') },
	{ value: 'wan', label: _('WAN') },
	{ value: 'lan', label: _('LAN traffic') }
];

/* Unique id counter for the chart's <linearGradient> defs: ids live in the
 * document, so two renders alive at once (a re-render racing a poll) must not
 * reuse the same id or one chart would borrow the other's gradient. */
var chartSeq = 0;

/* Nice round numbers for the Y axis: a chart whose top reads "3.47 MiB/s" is
 * harder to read than one whose top reads "4 MiB/s". */
function niceCeiling(value) {
	if (!value || value <= 0)
		return 1;

	var exponent = Math.floor(Math.log(value) / Math.LN2);
	var base = Math.pow(2, exponent);
	var steps = [ 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8 ];

	for (var i = 0; i < steps.length; i++)
		if (steps[i] * base >= value)
			return steps[i] * base;

	return 2 * base;
}

/* ---- hover readout, modelled on the SoC page's CPU usage history ---- */

function chartPointer(svg, evt) {
	try {
		if (typeof svg.createSVGPoint === 'function' && svg.getScreenCTM) {
			var m = svg.getScreenCTM();
			if (m) {
				var pt = svg.createSVGPoint();
				pt.x = evt.clientX; pt.y = evt.clientY;
				return pt.matrixTransform(m.inverse());
			}
		}
	} catch (e) {
		/* Fall through to the viewBox mapping below. */
	}

	var rect = svg.getBoundingClientRect();
	var vb = String(svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);

	if (!rect.width || vb.length !== 4 || !isFinite(vb[2]) || !isFinite(vb[3]))
		return null;

	return {
		x: (evt.clientX - rect.left) / rect.width * vb[2],
		y: (evt.clientY - rect.top) / Math.max(1, rect.height) * vb[3]
	};
}

function chartNearest(xs, x) {
	var best = 0, bestD = Infinity;

	for (var i = 0; i < xs.length; i++) {
		var d = Math.abs(xs[i] - x);

		if (d < bestD) { bestD = d; best = i; }
	}

	return best;
}

function fmtSampleClock(ms) {
	var d = new Date(ms);

	function pad(n) { return (n < 10) ? '0' + String(n) : String(n); }

	return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

return L.Class.extend({
	store: null,
	clients: null,
	selectedMac: '',
	selectedType: 'total',
	windowMinutes: 10,

	load: function() {
		this.store = common.createStore();

		return this.store.fetchLeases().then(L.bind(function() {
			return this.store.fetchSnapshot();
		}, this));
	},

	/* ---------------- summary ---------------- */

	summarise: function(clients) {
		var summary = {
			online: 0, total: clients.length, wireless: 0,
			lanUp: 0, lanDown: 0, wanUp: 0, wanDown: 0,
			lanTotalUp: 0, lanTotalDown: 0, wanTotalUp: 0, wanTotalDown: 0,
			connections: this.store.state.stats ? this.store.state.stats.conntrack : null,
			capacity: this.store.state.stats ? this.store.state.stats.conntrack_max : null
		};

		clients.forEach(function(entry) {
			if (entry.online)
				summary.online++;
			if (entry.wireless)
				summary.wireless++;
		});

		/* On a bridge the per-client conntrack counters are frozen by the
		 * offload; the hardware port counters are the figure that moves. The
		 * conntrack path stays for routed boxes, where it is the finer
		 * measurement. */
		var l2Rates = this.store.bridgeRates(false);
		var l2Totals = this.store.bridgeRates(true);

		if (l2Rates && l2Totals) {
			summary.lanUp = l2Rates.lanUp;
			summary.lanDown = l2Rates.lanDown;
			summary.wanUp = l2Rates.wanUp;
			summary.wanDown = l2Rates.wanDown;
			summary.lanTotalUp = l2Totals.lanUp;
			summary.lanTotalDown = l2Totals.lanDown;
			summary.wanTotalUp = l2Totals.wanUp;
			summary.wanTotalDown = l2Totals.wanDown;

			return summary;
		}

		clients.forEach(function(entry) {
			if (!entry.rate)
				return;

			summary.lanUp += entry.rate.lanUp || 0;
			summary.lanDown += entry.rate.lanDown || 0;
			summary.wanUp += entry.rate.wanUp || 0;
			summary.wanDown += entry.rate.wanDown || 0;

			summary.lanTotalUp += entry.total.lanUp || 0;
			summary.lanTotalDown += entry.total.lanDown || 0;
			summary.wanTotalUp += entry.total.wanUp || 0;
			summary.wanTotalDown += entry.total.wanDown || 0;
		});

		/* Client-to-client traffic is LAN traffic, so it is added here rather
		 * than shown as a figure of its own - that is what the tile means by
		 * "LAN", and Total picks it up through the same sum. It has no
		 * direction, so it goes under both arrows, the way a switched frame
		 * always shows up as rx on one port and tx on another.
		 *
		 * Not on a bridge: there the port counters behind the branch above
		 * already contain those frames. */
		var intra = this.store.state.intra;

		if (intra && intra.ok === true) {
			summary.lanUp += intra.rate || 0;
			summary.lanDown += intra.rate || 0;
			summary.lanTotalUp += intra.total || 0;
			summary.lanTotalDown += intra.total || 0;
		}

		return summary;
	},

	renderSummary: function(summary) {
		/* `idle` renders the tile as "not applicable" rather than "zero": on a
		 * routed box with one LAN subnet the counter can never move, and a hard
		 * 0 B/s there reads as a broken figure instead of an empty scope. */
		function block(label, up, down, totalUp, totalDown, title, idle) {
			var attrs = { 'class': 'clients-block' };

			if (title)
				attrs.title = title;

			function rate(value) {
				return idle ? '—' : common.formatRate(value);
			}

			function total(value) {
				return idle ? '' : '(' + common.formatSize(value) + ')';
			}

			return E('div', attrs, [
				E('div', { 'class': 'clients-block__title' }, label),
				E('div', { 'class': 'clients-block__row' }, [
					E('span', { 'class': 'clients-block__dir clients-block__dir--up' }, '↑'),
					E('span', { 'class': 'clients-block__rate' }, rate(up)),
					E('span', { 'class': 'clients-block__total' }, total(totalUp))
				]),
				E('div', { 'class': 'clients-block__row' }, [
					E('span', { 'class': 'clients-block__dir clients-block__dir--down' }, '↓'),
					E('span', { 'class': 'clients-block__rate' }, rate(down)),
					E('span', { 'class': 'clients-block__total' }, total(totalDown))
				])
			]);
		}

		var totalUp = summary.lanUp + summary.wanUp;
		var totalDown = summary.lanDown + summary.wanDown;
		var totalUpBytes = summary.lanTotalUp + summary.wanTotalUp;
		var totalDownBytes = summary.lanTotalDown + summary.wanTotalDown;
		var viaPorts = !!(this.store.state.bridge && this.store.state.bridge.mode);

		/* No LAN-scope byte since the collector started, on a box that would
		 * have to route them to see them: nothing has crossed between LAN
		 * subnets, so there is no number to show rather than a zero. */
		var lanIdle = !viaPorts &&
			!(summary.lanUp || summary.lanDown || summary.lanTotalUp || summary.lanTotalDown);

		/* The LAN figure means different things depending on the role of this
		 * box, so it says which one it is instead of leaving the reader to
		 * wonder why a busy LAN can read zero. */
		dom.content(this.summary, [
			block(_('LAN traffic'), summary.lanUp, summary.lanDown,
				summary.lanTotalUp, summary.lanTotalDown,
				viaPorts
					? _('What the clients on this LAN exchanged with each other, counted by the hardware port counters.')
					: _('What stayed inside the LAN: traffic this box routed between LAN subnets, plus the frames two clients exchanged with each other, counted by an nftables rule on the bridge. A switched frame has no direction, so it is counted under both arrows.'),
				lanIdle),
			block(_('WAN traffic'), summary.wanUp, summary.wanDown,
				summary.wanTotalUp, summary.wanTotalDown),
			block(_('Total'), totalUp, totalDown, totalUpBytes, totalDownBytes),
			E('div', { 'class': 'clients-block clients-block--facts' }, [
				E('div', { 'class': 'clients-block__title' }, _('Clients')),
				E('div', { 'class': 'clients-block__fact' }, [
					E('span', { 'class': 'clients-block__value' }, String(summary.online)),
					E('span', { 'class': 'clients-block__unit' }, _('online of %s').format(String(summary.total)))
				]),
				E('div', { 'class': 'clients-block__fact' }, [
					E('span', { 'class': 'clients-block__value' }, String(summary.wireless)),
					E('span', { 'class': 'clients-block__unit' }, _('wireless'))
				]),
				E('div', { 'class': 'clients-block__fact' }, [
					E('span', { 'class': 'clients-block__value' }, common.formatCount(summary.connections)),
					E('span', { 'class': 'clients-block__unit' },
						summary.capacity ? _('connections of %s').format(String(summary.capacity))
							: _('connections'))
				])
			])
		]);
	},

	/* ---------------- chart ---------------- */

	/*
	 * The series the chart draws for the selected type: `key` picks the value
	 * out of `seriesFor()`, and the label is what the legend and the tooltip
	 * call it.
	 *
	 * Everything but inner-LAN traffic is a pair. Client-to-client frames have
	 * no direction - both ends are clients, and the counter in the bridge
	 * family sees each frame once - so that one is a single line, and the
	 * drawing code iterates this list instead of assuming two.
	 */
	chartSeries: function() {
		return [
			{ key: 'up', cls: 'up', label: _('Upload rate'), color: 'var(--cl-up)' },
			{ key: 'down', cls: 'down', label: _('Download rate'), color: 'var(--cl-down)' }
		];
	},

	/*
	 * `pick(point)` returns { up, down } in bytes/second for a point, which
	 * lets the same drawing code serve the totals, one scope and a single
	 * device without a second implementation.
	 */
	seriesFor: function() {
		var type = this.selectedType;
		var mac = this.selectedMac;

		return function(point) {
			var source = point;

			if (mac) {
				source = point.byMac ? point.byMac[mac] : null;

				if (!source)
					return { up: 0, down: 0 };
			}

			if (type == 'wan')
				return { up: source.wanUp || 0, down: source.wanDown || 0 };

			if (type == 'lan')
				return { up: source.lanUp || 0, down: source.lanDown || 0 };

			return {
				up: (source.lanUp || 0) + (source.wanUp || 0),
				down: (source.lanDown || 0) + (source.wanDown || 0)
			};
		};
	},

	visiblePoints: function() {
		var trend = this.store.trend || [];

		if (!trend.length)
			return [];

		/* The window is measured back from the newest sample, not from this
		 * browser's clock: the points are stamped by the router, and a box
		 * without a battery-backed clock is not always right about the time -
		 * a skewed router would otherwise empty the chart. */
		var cutoff = trend[trend.length - 1].t - this.windowMinutes * 60000;

		return trend.filter(function(point) { return point.t >= cutoff; });
	},

	renderChart: function() {
		/* A point whose rate was not measurable (the first sample of a
		 * session has no baseline to differ against) is skipped entirely:
		 * drawing it as 0 would fake a rise from the floor and read as a
		 * triangle, exactly what the CPU usage history chart avoids by
		 * breaking its line at null samples. */
		var points = this.visiblePoints().filter(function(p) { return p.valid !== false; });
		var pick = this.seriesFor();
		var series = this.chartSeries();

		/* The legend names whatever is drawn, so switching type has to rebuild
		 * it: a single-series view showing two keys would promise a line that
		 * is not there. */
		if (this.legend)
			dom.content(this.legend, series.map(function(one) {
				return E('span', { 'class': 'clients-chart__key clients-chart__key--' + one.cls }, one.label);
			}));

		var width = 720, height = 220;
		var padX = 8, padTop = 14, padBottom = 10;
		var plotW = width - padX * 2;
		var plotH = height - padTop - padBottom;

		if (!points.length) {
			dom.content(this.chart, [
				E('div', { 'class': 'clients-chart__empty' },
					_('No samples yet. The chart appears as soon as the background collector records one.'))
			]);
			return;
		}

		var values = points.map(pick);
		var peak = 0;

		values.forEach(function(v) {
			series.forEach(function(one) {
				peak = Math.max(peak, v[one.key] || 0);
			});
		});

		var ceiling = niceCeiling(peak);
		var t0 = points[0].t;
		var t1 = points[points.length - 1].t;

		/* A single sample has no span; give it a nominal one so the line lands
		 * in the middle instead of dividing by zero. */
		if (t1 <= t0)
			t1 = t0 + 1000;

		function x(t) { return padX + (t - t0) / (t1 - t0) * plotW; }
		function y(v) { return padTop + plotH - (v / ceiling) * plotH; }

		function line(key) {
			return points.map(function(point, index) {
				var v = values[index][key];

				return (index ? 'L' : 'M') + x(point.t).toFixed(1) + ' ' + y(v).toFixed(1);
			}).join(' ');
		}

		/* Close a series down to the plot floor so it can be filled as an area,
		 * not just stroked. Both series are filled, each in its own colour, so
		 * the chart reads as two bands rather than two hairlines; the stroke
		 * paths below are drawn on top to keep the boundary crisp. */
		function area(key) {
			var base = (padTop + plotH).toFixed(1);
			var d = line(key);

			if (!d)
				return '';

			return d
				+ ' L' + x(t1).toFixed(1) + ' ' + base
				+ ' L' + x(t0).toFixed(1) + ' ' + base
				+ ' Z';
		}

		/* Three anchor labels only - top, middle, floor - the way the SoC
		 * page's usage history does it; one per gridline crowds the card. */
		var grid = '';

		for (var i = 0; i <= 4; i++) {
			var gy = y(ceiling * i / 4);

			grid += '<line x1="' + padX + '" y1="' + gy.toFixed(1)
				+ '" x2="' + (width - padX) + '" y2="' + gy.toFixed(1)
				+ '" stroke="var(--cl-rule)" stroke-width="1" stroke-dasharray="3 3"/>';
		}

		[4, 2, 0].forEach(function(step) {
			var gy = y(ceiling * step / 4);

			grid += '<text x="' + (padX + 2) + '" y="' + (gy - 4).toFixed(1)
				+ '" font-size="10" fill="var(--cl-muted)">'
				+ common.formatRate(ceiling * step / 4) + '</text>';
		});

		var last = values[values.length - 1];

		function esc(text) {
			return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}

		/* document.createElement('svg') yields an HTMLUnknownElement that renders
		 * nothing - its text children show up as plain inline text instead of a
		 * chart. SVG nodes only exist when the parser or createElementNS makes
		 * them, so the chart is assembled as markup and handed to innerHTML,
		 * which puts every node into the SVG namespace. Everything interpolated
		 * is a number, a formatted rate or a clock time; only the two
		 * translatable strings need escaping. */
		var host = E('div');
		var gid = 'clim' + (++chartSeq);

		/* Built from the series list rather than written out twice: the shape
		 * of the drawing is the same for one series and for two, and the
		 * inner-LAN type proves it. */
		var defs = '', marks = '';

		series.forEach(function(one) {
			defs += '<linearGradient id="' + gid + '-' + one.key + '" x1="0" y1="0" x2="0" y2="1">'
				+ '<stop offset="0" style="stop-color:' + one.color + ';stop-opacity:.40"/>'
				+ '<stop offset="1" style="stop-color:' + one.color + ';stop-opacity:0"/>'
				+ '</linearGradient>';

			marks += '<path d="' + area(one.key) + '" fill="url(#' + gid + '-' + one.key + ')" stroke="none"/>'
				+ '<path d="' + line(one.key) + '" fill="none" stroke="' + one.color + '" stroke-width="2"'
				+ ' stroke-linejoin="round" stroke-linecap="round"/>'
				+ '<circle cx="' + x(t1).toFixed(1) + '" cy="' + y(last[one.key] || 0).toFixed(1)
				+ '" r="3" fill="' + one.color + '"/>';
		});

		host.innerHTML =
			'<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" class="clients-chart__svg"'
			+ ' style="display:block;cursor:crosshair" role="img">'
			+ '<title>' + esc(_('Traffic trend')) + '</title>'
			+ '<desc>' + esc(_('Upload and download rates over the selected window.')) + '</desc>'
			+ '<defs>' + defs + '</defs>'
			+ '<g>' + grid + '</g>'
			+ marks
			+ '</svg>';

		var svg = host.firstChild;

		/* The hover layer: a dashed crosshair snapped to the nearest sample,
		 * one dot per series, and an HTML readout with the concrete values -
		 * the same interaction the CPU usage history chart offers. HTML rather
		 * than SVG text because the box is only measurable once rendered. The
		 * svg node dies with the next poll, so the listeners never leak. */
		var wrap = E('div', { 'style': 'position:relative' }, [ svg ]);

		var tip = E('div', {
			'style': 'position:absolute;display:none;z-index:3;pointer-events:none;min-width:8em;'
				+ 'padding:.3em .5em;border:1px solid var(--cl-rule);border-radius:6px;'
				+ 'background:var(--cl-surface);color:var(--cl-text);'
				+ 'box-shadow:0 2px 8px rgba(15,23,42,.18);font-size:11px;line-height:1.5;'
				+ 'font-variant-numeric:tabular-nums;text-align:left'
		});
		wrap.appendChild(tip);

		function svgChild(tag, attrs) {
			var el = document.createElementNS('http://www.w3.org/2000/svg', tag);

			for (var k in attrs)
				el.setAttribute(k, attrs[k]);

			return el;
		}

		var guide = svgChild('line', {
			'x1': 0, 'x2': 0, 'y1': padTop, 'y2': padTop + plotH,
			'stroke': 'var(--cl-muted)', 'stroke-width': '1', 'stroke-dasharray': '3 3',
			'visibility': 'hidden'
		});
		svg.appendChild(guide);

		var dots = series.map(function(one) {
			var dot = svgChild('circle', {
				'cx': 0, 'cy': 0, 'r': '3.5',
				'fill': one.color, 'stroke': 'var(--cl-surface)', 'stroke-width': '1.5',
				'visibility': 'hidden'
			});
			svg.appendChild(dot);
			return dot;
		});

		var xs = points.map(function(point) { return x(point.t); });

		function hide() {
			tip.style.display = 'none';
			guide.setAttribute('visibility', 'hidden');
			dots.forEach(function(dot) { dot.setAttribute('visibility', 'hidden'); });
		}

		function show(evt) {
			var p = chartPointer(svg, evt);

			if (!p || !xs.length)
				return;

			var i = chartNearest(xs, p.x);
			var v = values[i];

			guide.setAttribute('x1', xs[i].toFixed(1));
			guide.setAttribute('x2', xs[i].toFixed(1));
			guide.setAttribute('visibility', 'visible');

			series.forEach(function(one, d) {
				var value = v[one.key] || 0;

				dots[d].setAttribute('cx', xs[i].toFixed(1));
				dots[d].setAttribute('cy', y(value).toFixed(1));
				dots[d].setAttribute('visibility', 'visible');
			});

			tip.innerHTML = '';
			tip.appendChild(E('div', {
				'style': 'color:var(--cl-muted);font-weight:650;margin-bottom:2px'
			}, fmtSampleClock(points[i].t)));

			series.map(function(one) {
				return {
					label: one.label,
					value: common.formatRate(v[one.key] || 0),
					color: one.color
				};
			})
			.forEach(function(row) {
				tip.appendChild(E('div', {
					'style': 'display:flex;align-items:center;gap:.4em;white-space:nowrap'
				}, [
					E('span', {
						'style': 'width:.9em;height:2px;border-radius:2px;background:' + row.color + ';flex:0 0 auto'
					}),
					E('span', { 'style': 'color:var(--cl-muted)' }, row.label),
					E('span', {
						'style': 'margin-left:auto;padding-left:.6em;font-weight:700'
					}, row.value)
				]));
			});

			var wr = wrap.getBoundingClientRect();
			var px = evt.clientX - wr.left, py = evt.clientY - wr.top;

			tip.style.display = 'block';

			var left = Math.min(Math.max(0, px - tip.offsetWidth / 2), Math.max(0, wr.width - tip.offsetWidth));
			var top = py - tip.offsetHeight - 10;

			if (top < 0)
				top = py + 12;

			tip.style.left = left + 'px';
			tip.style.top = top + 'px';
		}

		svg.addEventListener('mousemove', show);
		svg.addEventListener('mouseleave', hide);

		dom.content(this.chart, [ wrap ]);
	},

	deviceOptions: function() {
		var clients = this.clients || [];
		var options = [ E('option', { 'value': '' }, _('All devices')) ];

		clients.filter(function(entry) { return entry.mac; }).forEach(function(entry) {
			options.push(E('option', { 'value': entry.mac }, [
				entry.hostname || entry.ipv4[0] || entry.mac
			]));
		});

		return options;
	},

	refreshDeviceSelect: function() {
		var select = this.deviceSelect;
		var current = select.value;
		var options = this.deviceOptions();

		dom.content(select, options);

		/* Keep the selection across a refresh, and drop it if the device left the
		 * table - otherwise the chart would silently go flat. */
		var still = options.some(function(option) { return option.getAttribute('value') == current; });

		select.value = still ? current : '';
		this.selectedMac = select.value;
	},

	/* ---------------- view ---------------- */

	update: function() {
		var clients = this.store.clients();

		this.clients = clients;
		this.store.pushTrend(clients);

		this.renderSummary(this.summarise(clients));
		this.refreshDeviceSelect();
		this.renderChart();
	},

	render: function() {
		var self = this;

		common.ensureStylesheet();

		this.summary = E('div', { 'class': 'clients-blocks' });
		this.chart = E('div', { 'class': 'clients-chart' });
		/* Created here, not inline in the tree below: update() renders the
		 * chart before the tree exists, and the first paint must already name
		 * the series it drew. */
		this.legend = E('div', { 'class': 'clients-chart__legend' });
		this.deviceSelect = E('select', { 'id': 'clients-ov-device', 'name': 'clients-ov-device', 'class': 'cbi-input-select' }, this.deviceOptions());

		this.deviceSelect.addEventListener('change', function() {
			self.selectedMac = self.deviceSelect.value;
			self.renderChart();
		});

		var typeSelect = E('select', { 'id': 'clients-ov-type', 'name': 'clients-ov-type', 'class': 'cbi-input-select' }, TYPES.map(function(type) {
			return E('option', { 'value': type.value, 'selected': (type.value == self.selectedType) }, type.label);
		}));

		typeSelect.addEventListener('change', function() {
			self.selectedType = typeSelect.value;
			self.renderChart();
		});

		var windowSelect = E('select', { 'id': 'clients-ov-window', 'name': 'clients-ov-window', 'class': 'cbi-input-select' }, WINDOWS.map(function(win) {
			return E('option', { 'value': String(win.minutes), 'selected': (win.minutes == self.windowMinutes) }, win.label);
		}));

		windowSelect.addEventListener('change', function() {
			self.windowMinutes = parseInt(windowSelect.value, 10) || 10;
			self.renderChart();
		});

		this.update();

		poll.add(L.bind(function() {
			var jobs;

			/* hidden covers two cases: the browser tab being in the background,
			 * and this pane not being the active tab of the page - the main
			 * view flips the flag when the user switches tabs. */
			if (document.hidden || this.hidden)
				return Promise.resolve();

			jobs = [ this.store.fetchSnapshot() ];

			if ((Date.now() - this.store.lastLeaseLoad) >= common.LEASE_INTERVAL * 1000)
				jobs.push(this.store.fetchLeases());

			if ((Date.now() - this.store.lastHistoryLoad) >= common.HISTORY_INTERVAL * 1000)
				jobs.push(this.store.loadHistory());

			return Promise.all(jobs).then(function() {
				self.update();
			}).catch(function(error) {
				L.error(error);
			});
		}, this), common.SAMPLE_INTERVAL);

	var bridgeMode = !!(this.store.state.bridge && this.store.state.bridge.mode);

	return E('div', { 'class': 'clients-pane' }, [
		E('div', { 'class': 'cbi-map-descr' },
			_('Aggregate traffic of every client this device can see, split between the local network and the internet.')),
		E('div', { 'class': 'cbi-section' }, [
			this.summary,
			E('h3', {}, _('Realtime traffic trends')),
			E('div', { 'class': 'clients-chart__controls' }, [
				E('label', { 'class': 'clients-control' }, [
					E('span', {}, _('Select device')),
					this.deviceSelect
				]),
				E('label', { 'class': 'clients-control' }, [
					E('span', {}, _('Type')),
					typeSelect
				]),
				E('label', { 'class': 'clients-control' }, [
					E('span', {}, _('Window')),
					windowSelect
				]),
				this.legend
			]),
			this.chart,
			E('p', { 'class': 'clients-note' },
				bridgeMode
					? _('This device bridges, so the figures come from the hardware port counters: WAN is the traffic through the uplink port, LAN is what the remaining ports carried. The bracketed figures are counted by the background collector since it started.')
					: _('Rates are differentiated from kernel conntrack counters, which keep counting for hardware-offloaded flows. The bracketed figures are counted by the background collector since it started - conntrack counters belong to a flow, so they are a floor, not a lifetime total. LAN traffic is what this box routed between LAN subnets; frames between two clients of the same subnet are switched by the bridge and never reach conntrack.'))
		])
	]);
	}
});
