// ==UserScript==
// @name          IMDb Lists Marker
// @description   Emphasize the links for movies and people in your IMDb lists
// @namespace     http://www.flickr.com/photos/ricardo_ferreira/2502798105/
// @homepageURL   https://openuserjs.org/scripts/AltoRetrato/IMDb_My_Movies_enhancer
// @copyright     2008-2024, Ricardo Mendonca Ferreira
// @license       GPL-3.0-or-later
// @version       1.66
// @match         https://*.imdb.com/*
// @match         http://*.imdb.com/*
// @exclude       https://*.imdb.com/images/*
// @exclude       http://*.imdb.com/images/*
// @grant         none
// @inject-into   page
// @noframes
// @run-at        document-idle
// ==/UserScript==
//
// Based on IMDb 'My Movies' enhancer by Ricardo Mendonça Ferreira (AltoRetrato),
// GPL-3.0-or-later. Version 1.54 replaces the removed /export CSV links with the
// list queries the IMDb site uses now. Highlight data is still stored in the
// browser and applied locally, so opening a page does not download the lists again.

(function () {
  'use strict';

  var VERSION = '1.66';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var GQL = 'https://caching.graphql.imdb.com/';
  var PAGE_SIZE = 250;
  var MAX_PAGES = 260;
  var MAX_HTML_PAGES = 220;

  var TITLES = 'Titles';
  var PEOPLE = 'People';
  var WATCHLIST = 'watchlist';
  var RATINGS = 'ratings';
  var CHECKINS = 'checkins';

  var TITLE_PATH = /^\/title\/tt0*(\d+)\/?$/;
  var NAME_PATH = /^\/name\/nm0*(\d+)\/?$/;
  var LISTS_PATH = /^\/user\/[^/]+\/lists\/?$/;

  var customColors = {
    'Your Watchlist': 'DarkGoldenRod',
    'Your ratings': 'Green',
    'Your check-ins': 'DarkGreen'
  };
  var listOrder = ['Your Watchlist', 'Your ratings'];

  var TITLE_ITEMS = [
    'query ($id: ID!, $after: String) {',
    '  list(id: $id) {',
    '    titleListItemSearch(first: ' + PAGE_SIZE + ', after: $after) {',
    '      pageInfo { hasNextPage endCursor }',
    '      edges { title { id ratingsSummary { aggregateRating } } }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  var NAME_ITEMS = [
    'query ($id: ID!, $after: String) {',
    '  list(id: $id) {',
    '    nameListItemSearch(first: ' + PAGE_SIZE + ', after: $after) {',
    '      pageInfo { hasNextPage endCursor }',
    '      edges { name { id } }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  var USER_LISTS = [
    'query ($id: ID!, $after: ID) {',
    '  userListSearch(',
    '    first: ' + PAGE_SIZE + ',',
    '    after: $after,',
    '    listOwnerUserId: $id,',
    '    sort: { by: DATE_MODIFIED, order: DESC },',
    '    filter: { anyClassTypes: [LIST], anyListTypes: [TITLES, PEOPLE] }',
    '  ) {',
    '    pageInfo { hasNextPage endCursor }',
    '    edges { node { id name { originalText } listType { id } } }',
    '  }',
    '}'
  ].join('\n');

  var RATINGS_ITEMS = [
    'query ($userId: ID!, $after: String) {',
    '  userRatings(first: ' + PAGE_SIZE + ', userId: $userId, after: $after) {',
    '    pageInfo { hasNextPage endCursor }',
    '    edges {',
    '      node {',
    '        title { id ratingsSummary { aggregateRating } }',
    '        userRating { value }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  function encodeConst(constId) {
    var match = /^(?:tt|nm)0*(\d+)$/.exec(constId || '');
    if (!match) return '';
    return parseInt(match[1], 10).toString(36);
  }

  function encodePathNumber(num) {
    return parseInt(num, 10).toString(36);
  }

  function isLoggedIn() {
    var next = document.getElementById('__NEXT_DATA__');
    if (!next || !next.textContent) return false;
    var at = next.textContent.indexOf('"isLoggedIn":');
    if (at === -1) return false;
    return next.textContent.slice(at, at + 20).indexOf('true') !== -1;
  }

  function readListsPage() {
    var next = document.getElementById('__NEXT_DATA__');
    if (!next) return null;
    var data = JSON.parse(next.textContent);
    var page = data && data.props && data.props.pageProps;
    if (!page) return null;
    var main = page.mainColumnData || {};
    var profile = main.userProfile || {};
    var name = profile.username && profile.username.text;
    return {
      isOwner: page.isListOwner === true,
      userId: profile.userId || '',
      userName: name || ''
    };
  }

  function storageKey(userId) {
    return 'myMovies-' + userId;
  }

  function loadStored(userId) {
    var raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.myLists)) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function saveStored(userId, userName, myLists, orderIdx) {
    localStorage.setItem(storageKey(userId), JSON.stringify({
      version: VERSION,
      userName: userName,
      listOrder: orderIdx,
      myLists: myLists
    }));
    localStorage.setItem('myMovies-active-user', userId);
    localStorage.setItem('myMovies-active-name', userName || '');
  }

  function clearStored(userId) {
    localStorage.removeItem(storageKey(userId));
  }

  function sessionId() {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf('session-id=') === 0) return decodeURIComponent(parts[i].slice(11));
    }
    return '';
  }

  function gql(query, variables) {
    var headers = {
      'content-type': 'application/json',
      'x-imdb-client-name': 'imdb-web-next'
    };
    var sid = sessionId();
    if (sid) headers['x-amzn-sessionid'] = sid;
    return fetch(GQL, {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (res) {
      return res.text().then(function (text) {
        var json;
        try {
          json = JSON.parse(text);
        } catch (err) {
          throw new Error('Unexpected response (HTTP ' + res.status + ')');
        }
        if (!res.ok && !json.data) {
          var message = json.errors && json.errors[0] && json.errors[0].message;
          throw new Error(message || ('HTTP ' + res.status));
        }
        return json;
      });
    });
  }

  function firstError(json) {
    return json && json.errors && json.errors[0] && json.errors[0].message || '';
  }

  function walkPages(loadPage) {
    var after = null;
    var pages = 0;

    function step(acc) {
      if (pages >= MAX_PAGES) return Promise.resolve(acc);
      pages += 1;
      return loadPage(after).then(function (pack) {
        if (!pack || !pack.edges) return acc;
        acc.push(pack);
        if (!pack.pageInfo || !pack.pageInfo.hasNextPage || !pack.pageInfo.endCursor) return acc;
        after = pack.pageInfo.endCursor;
        return step(acc);
      });
    }

    return step([]);
  }

  function titleFromEdge(edge) {
    if (!edge) return null;
    var item = edge.title || edge.listItem;
    if (!item && edge.node) item = edge.node.title || edge.node.listItem;
    if (item && item.title && item.id && item.id.indexOf('tt') !== 0) item = item.title;
    if (!item || !item.id || item.id.indexOf('tt') !== 0) return null;
    return item;
  }

  function nameFromEdge(edge) {
    if (!edge) return null;
    var item = edge.name || edge.listItem;
    if (!item && edge.node) item = edge.node.name || edge.node.listItem;
    if (item && item.name && item.id && item.id.indexOf('nm') !== 0) item = item.name;
    if (!item || !item.id || item.id.indexOf('nm') !== 0) return null;
    return item;
  }

  function ownScore(edge, title) {
    var mine = title && title.userRating && title.userRating.value;
    if (!mine && edge.node && edge.node.userRating) mine = edge.node.userRating.value;
    if (!mine && edge.userRating) mine = edge.userRating.value;
    return mine || '';
  }

  function storeTitleEdges(ids, edges) {
    (edges || []).forEach(function (edge) {
      var title = titleFromEdge(edge);
      var code = title && encodeConst(title.id);
      if (!code) return;
      var rating = title.ratingsSummary && title.ratingsSummary.aggregateRating;
      var mine = ownScore(edge, title);
      ids[code] = { i: rating || '' };
      if (mine) ids[code].m = mine;
    });
  }

  function storeNameEdges(ids, edges) {
    (edges || []).forEach(function (edge) {
      var person = nameFromEdge(edge);
      var code = person && encodeConst(person.id);
      if (code && !ids[code]) ids[code] = {};
    });
  }

  function collectTitles(listId) {
    var ids = {};
    return walkPages(function (after) {
      return gql(TITLE_ITEMS, { id: listId, after: after }).then(function (json) {
        var conn = json.data && json.data.list && json.data.list.titleListItemSearch;
        if (!conn) throw new Error(firstError(json) || 'Could not read this title list');
        return conn;
      });
    }).then(function (pages) {
      pages.forEach(function (conn) { storeTitleEdges(ids, conn.edges); });
      return ids;
    });
  }

  function collectPredefined(classType, userId) {
    var query = [
      'query ($after: String) {',
      '  predefinedList(classType: ' + classType + ') {',
      '    titleListItemSearch(first: ' + PAGE_SIZE + ', after: $after) {',
      '      pageInfo { hasNextPage endCursor }',
      '      edges { title { id ratingsSummary { aggregateRating } } }',
      '    }',
      '  }',
      '}'
    ].join('\n');
    var ids = {};
    return walkPages(function (after) {
      return gql(query, { after: after }).then(function (json) {
        var list = json.data && json.data.predefinedList;
        if (!list) {
          var message = firstError(json);
          if (message) throw new Error(message);
          return { edges: [], pageInfo: { hasNextPage: false } };
        }
        if (!list.titleListItemSearch) throw new Error(firstError(json) || 'Could not read this list');
        return list.titleListItemSearch;
      });
    }).then(function (pages) {
      pages.forEach(function (conn) { storeTitleEdges(ids, conn.edges); });
      return ids;
    }).catch(function (err) {
      var paths = classType === 'CHECK_INS' ? checkinPaths(userId) : ['/list/watchlist/'];
      return collectFromPaths(paths).then(function (page) {
        if (page.hasList) return page.ids;
        if (classType === 'CHECK_INS') return {};
        throw err;
      });
    });
  }

  function checkinPaths(userId) {
    var paths = [];
    var link = document.querySelector('a[href*="/checkins"]');
    if (link) {
      try { paths.push(new URL(link.href, location.origin).pathname); } catch (err) {}
    }
    if (userId && userId.indexOf('ur') === 0) paths.push('/user/' + userId + '/checkins/');
    var replaced = location.pathname.replace(/\/lists\/?$/, '/checkins/');
    if (replaced !== location.pathname) paths.push(replaced);
    return paths.filter(function (path, index) { return paths.indexOf(path) === index; });
  }

  function listPagePath(path, page) {
    var url = new URL(path, location.origin);
    url.searchParams.set('sort', 'list_order,asc');
    url.searchParams.set('page', String(page));
    return url.pathname + url.search;
  }

  function pageOnly(path, page) {
    var url = new URL(path, location.origin);
    url.searchParams.set('page', String(page));
    return url.pathname + url.search;
  }

  function fetchHtml(path, attempt) {
    attempt = attempt || 0;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 25000) : null;
    return fetch(location.origin + path, {
      credentials: 'same-origin',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        return new Promise(function (resolve) { setTimeout(resolve, 2000 * Math.pow(2, attempt)); }).then(function () {
          return fetchHtml(path, attempt + 1);
        });
      }
      if (res.url.indexOf('/registration/signin') !== -1) throw new Error('Sign in required');
      return res.text().then(function (html) {
        var finalPath = path;
        try { finalPath = new URL(res.url).pathname; } catch (err) {}
        return { html: html, finalPath: finalPath };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (attempt < 4) {
        return new Promise(function (resolve) { setTimeout(resolve, 2000 * Math.pow(2, attempt)); }).then(function () {
          return fetchHtml(path, attempt + 1);
        });
      }
      throw err;
    });
  }

  function readListPayload(path) {
    return fetchHtml(path).then(function (loaded) {
      var match = loaded.html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('Could not read the list page');
      var data = JSON.parse(match[1]);
      var main = data.props && data.props.pageProps && data.props.pageProps.mainColumnData;
      var list = main && (main.list || main.predefinedList);
      var titleSearch = (list && list.titleListItemSearch) || (main && main.advancedTitleSearch);
      var nameSearch = list && list.nameListItemSearch;
      var search = titleSearch || nameSearch;
      return {
        hasList: !!search,
        listId: list && list.id || '',
        hasNext: !!(search && search.pageInfo && search.pageInfo.hasNextPage),
        titleEdges: titleSearch && titleSearch.edges || [],
        nameEdges: nameSearch && nameSearch.edges || [],
        total: search && search.total || 0,
        endCursor: search && search.pageInfo && search.pageInfo.endCursor || '',
        finalPath: loaded.finalPath
      };
    });
  }

  function collectEntireList(path, options) {
    options = options || {};
    var ids = {};
    var page = 1;
    var listPath = path;
    var sawTitles = false;
    var sawPeople = false;
    function finish(hasList) {
      if (options.list) {
        if (sawPeople && !sawTitles) options.list.type = PEOPLE;
        else if (sawTitles) options.list.type = TITLES;
      }
      return { ids: ids, hasList: hasList };
    }
    function step() {
      if (page > MAX_HTML_PAGES) return Promise.resolve(finish(true));
      var requestPath = page === 1 ? listPath : (options.ratings ? pageOnly(listPath, page) : listPagePath(listPath, page));
      return readListPayload(requestPath).then(function (pack) {
        if (!pack.hasList) return finish(page > 1);
        if (page === 1 && pack.finalPath) listPath = pack.finalPath;
        if (!options.ratings && page === 1 && pack.listId && pack.listId.indexOf('ls') === 0) {
          listPath = '/list/' + pack.listId + '/';
        }
        var before = Object.keys(ids).length;
        if (pack.titleEdges.length) sawTitles = true;
        if (pack.nameEdges.length) sawPeople = true;
        storeTitleEdges(ids, pack.titleEdges);
        storeNameEdges(ids, pack.nameEdges);
        if (options.onCount) options.onCount(Object.keys(ids).length, pack.total || 0);
        if (!pack.hasNext || Object.keys(ids).length === before) return finish(true);
        page += 1;
        return step();
      });
    }
    return step();
  }

  function collectFromPaths(paths) {
    var index = 0;
    function next() {
      if (index >= paths.length) return Promise.resolve({ ids: {}, hasList: false });
      var path = paths[index];
      index += 1;
      return collectEntireList(path).then(function (page) {
        if (page.hasList) return page;
        return next();
      }, function () {
        return next();
      });
    }
    return next();
  }

  function collectNames(listId) {
    var ids = {};
    return walkPages(function (after) {
      return gql(NAME_ITEMS, { id: listId, after: after }).then(function (json) {
        var conn = json.data && json.data.list && json.data.list.nameListItemSearch;
        if (!conn) throw new Error(firstError(json) || 'Could not read this people list');
        return conn;
      });
    }).then(function (pages) {
      pages.forEach(function (conn) {
        (conn.edges || []).forEach(function (edge) {
          var code = edge && edge.name && encodeConst(edge.name.id);
          if (code) ids[code] = {};
        });
      });
      return ids;
    });
  }

  function collectRatings(userId) {
    var ids = {};
    return walkPages(function (after) {
      return gql(RATINGS_ITEMS, { userId: userId, after: after }).then(function (json) {
        var conn = json.data && json.data.userRatings;
        if (!conn) throw new Error(firstError(json) || 'Could not read your ratings');
        return conn;
      });
    }).then(function (pages) {
      pages.forEach(function (conn) {
        (conn.edges || []).forEach(function (edge) {
          var node = edge && edge.node;
          var title = node && node.title;
          var code = title && encodeConst(title.id);
          if (!code) return;
          var mine = node.userRating && node.userRating.value;
          var imdb = title.ratingsSummary && title.ratingsSummary.aggregateRating;
          ids[code] = { m: mine || '', i: imdb || '' };
        });
      });
      return ids;
    });
  }

  function listMeta(node) {
    var typeId = node.listType && (node.listType.id || node.listType);
    var classId = node.listClass && (node.listClass.id || node.listClass);
    if (classId === 'WATCH_LIST' || classId === 'RATINGS' || classId === 'CHECK_INS') return null;
    if (typeId === 'IMAGES' || typeId === 'VIDEOS') return null;
    var name = node.id;
    if (typeof node.name === 'string') name = node.name;
    else if (node.name) name = node.name.originalText || node.name.text || node.id;
    return {
      name: name,
      id: node.id,
      type: typeId === 'PEOPLE' || typeId === 'NAMES' ? PEOPLE : TITLES
    };
  }

  function cleanListName(label) {
    return String(label || '')
      .replace(/^.*\b(?:for|für|para|pour|per|de)\b\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function absorbListSearch(found, seen, search) {
    (search && search.edges || []).forEach(function (edge) {
      var node = edge && (edge.node || edge.list);
      if (!node || !node.id || node.id.indexOf('ls') !== 0 || seen[node.id]) return;
      var meta = listMeta(node);
      if (!meta) return;
      seen[node.id] = true;
      found.push(meta);
    });
  }

  function listsFromHtml(html) {
    var found = [];
    var seen = {};
    var hasNext = false;
    var match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
      try {
        var data = JSON.parse(match[1]);
        var main = data.props && data.props.pageProps && data.props.pageProps.mainColumnData;
        var search = main && main.userListSearch;
        absorbListSearch(found, seen, search);
        hasNext = !!(search && search.pageInfo && search.pageInfo.hasNextPage);
      } catch (err) {}
    }
    var tags = html.match(/<a\b[^>]*>/gi) || [];
    tags.forEach(function (tag) {
      var href = /href="([^"]+)"/.exec(tag);
      if (!href || href[1].indexOf('/list/ls') === -1) return;
      var idMatch = /\/list\/(ls\d+)/.exec(href[1]);
      if (!idMatch || seen[idMatch[1]]) return;
      var label = /aria-label="([^"]*)"/.exec(tag);
      seen[idMatch[1]] = true;
      found.push({
        name: cleanListName(label && label[1]) || idMatch[1],
        id: idMatch[1],
        type: TITLES
      });
    });
    return { lists: found, hasNext: hasNext };
  }

  function collectListsFromSite(userId) {
    var found = [];
    var seen = {};
    var page = 1;
    var path = '/user/' + userId + '/lists/';
    function step() {
      if (page > 20) return Promise.resolve(found);
      var request = page === 1 ? path : pageOnly(path, page);
      return fetchHtml(request).then(function (loaded) {
        if (page === 1 && loaded.finalPath) path = loaded.finalPath;
        var parsed = listsFromHtml(loaded.html);
        var before = found.length;
        parsed.lists.forEach(function (list) {
          if (seen[list.id]) return;
          seen[list.id] = true;
          found.push(list);
        });
        if (!parsed.hasNext || found.length === before) return found;
        page += 1;
        return step();
      });
    }
    return step();
  }

  function fetchCustomListsGraphql(userId) {
    var found = [];
    return walkPages(function (after) {
      return gql(USER_LISTS, { id: userId, after: after }).then(function (json) {
        var conn = json.data && json.data.userListSearch;
        if (!conn) throw new Error(firstError(json) || 'Could not read your lists');
        return conn;
      });
    }).then(function (pages) {
      pages.forEach(function (conn) {
        (conn.edges || []).forEach(function (edge) {
          var node = edge && edge.node;
          if (!node || !node.id) return;
          var typeId = node.listType && node.listType.id;
          if (typeId !== 'TITLES' && typeId !== 'PEOPLE') return;
          found.push({
            name: node.name && node.name.originalText || node.id,
            id: node.id,
            type: typeId === 'PEOPLE' ? PEOPLE : TITLES
          });
        });
      });
      return found;
    });
  }

  function fetchCustomLists(userId) {
    return Promise.all([
      collectListsFromSite(userId).catch(function () { return []; }),
      fetchCustomListsGraphql(userId).catch(function () { return []; })
    ]).then(function (parts) {
      var seen = {};
      var found = [];
      parts.forEach(function (lists) {
        lists.forEach(function (list) {
          if (!list || !list.id || seen[list.id]) return;
          seen[list.id] = true;
          found.push(list);
        });
      });
      return found;
    });
  }

  function listColor(name, type) {
    if (customColors[name]) return customColors[name];
    return type === PEOPLE ? 'DarkMagenta' : 'DarkCyan';
  }

  function orderIndexes(myLists) {
    var order = [];
    listOrder.forEach(function (name) {
      for (var i = 0; i < myLists.length; i++) {
        if (myLists[i].name === name) {
          order.push(i);
          break;
        }
      }
    });
    for (var i = 0; i < myLists.length; i++) {
      if (order.indexOf(i) === -1) order.push(i);
    }
    return order;
  }

  function statusBox() {
    var box = document.createElement('div');
    box.id = 'imdb-mme-status';
    box.style.cssText = [
      'margin: 10px 0',
      'padding: 8px 10px',
      'max-width: 720px',
      'background: #fff',
      'color: #111',
      'border: 1px solid #ccc',
      'font: 13px/1.4 Verdana, sans-serif',
      'white-space: pre-wrap'
    ].join(';');
    return box;
  }

  function makeButton(label, title, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.style.cssText = 'margin: 0 8px 8px 0; padding: 6px 10px; font-size: 12px; cursor: pointer;';
    button.addEventListener('click', onClick);
    return button;
  }

  function installListsPage(page) {
    var heading = document.querySelector('h1');
    if (!heading || document.getElementById('imdb-mme-bar')) return;

    var bar = document.createElement('div');
    bar.id = 'imdb-mme-bar';
    bar.style.marginTop = '10px';
    var status = statusBox();
    status.style.display = 'none';
    var running = false;

    function show(text) {
      status.style.display = 'block';
      status.textContent = text;
    }

    bar.appendChild(makeButton('Refresh highlight data', 'Download your lists into this browser', function () {
      if (running) return;
      running = true;
      show('Loading your lists...');
      refreshData(page, show).then(function () {
        running = false;
        rehighlight(page.userId);
      }, function (err) {
        running = false;
        show('Could not refresh highlight data.\n' + (err && err.message ? err.message : err));
      });
    }));

    bar.appendChild(makeButton('Clear highlight data', 'Remove the saved highlight data', function () {
      clearStored(page.userId);
      if (localStorage.getItem('myMovies-active-user') === page.userId) {
        localStorage.removeItem('myMovies-active-user');
        localStorage.removeItem('myMovies-active-name');
      }
      localStorage.removeItem('myMovies-refreshed-at');
      localStorage.removeItem('myMovies-refresh-lock');
      location.reload();
    }));

    bar.appendChild(makeButton("What's this?", 'What these buttons do', function () {
      show([
        'IMDb Lists Marker ' + VERSION,
        '',
        'Links to titles and people that are already in your lists are colored.',
        'A tooltip names the lists, and ratings include your score.',
        'Refresh downloads the data once. Other IMDb pages then use only this browser.',
        'The saved data refreshes by itself about once every 24 hours.',
        'A long ratings list is downloaded page by page. Keep this tab open until the count finishes.'
      ].join('\n'));
    }));

    bar.appendChild(status);
    heading.insertAdjacentElement('afterend', bar);
  }

  function previousIds(userId) {
    var prev = loadStored(userId);
    var map = {};
    if (!prev || !Array.isArray(prev.myLists)) return map;
    for (var i = 0; i < prev.myLists.length; i++) {
      var list = prev.myLists[i];
      if (list && list.id) map[list.id] = list.ids || {};
    }
    return map;
  }

  function refreshData(page, show) {
    var keepIds = previousIds(page.userId);
    var myLists = [
      { name: 'Your Watchlist', id: WATCHLIST, color: listColor('Your Watchlist', TITLES), type: TITLES, ids: keepIds[WATCHLIST] || {} },
      { name: 'Your ratings', id: RATINGS, color: listColor('Your ratings', TITLES), type: TITLES, ids: keepIds[RATINGS] || {} },
      { name: 'Your check-ins', id: CHECKINS, color: listColor('Your check-ins', TITLES), type: TITLES, ids: keepIds[CHECKINS] || {} }
    ];
    var failed = [];

    return fetchCustomLists(page.userId).then(function (custom) {
      custom.forEach(function (list) {
        myLists.push({
          name: list.name,
          id: list.id,
          color: listColor(list.name, list.type),
          type: list.type,
          ids: keepIds[list.id] || {}
        });
      });
      var order = orderIndexes(myLists);

      var index = 0;
      function next() {
        if (index >= myLists.length) {
          localStorage.setItem('myMovies-refreshed-at', String(Date.now()));
          saveStored(page.userId, page.userName, myLists, order);
          var done = 'Saved highlight data in this browser.';
          if (failed.length) done += '\nCould not load:\n- ' + failed.join('\n- ');
          show(done);
          return;
        }
        var list = myLists[index];
        index += 1;
        show('Loading ' + index + '/' + myLists.length + '  ' + list.name);
        return loadOne(list, page.userId, show, function (ids) {
          list.ids = ids;
          try { saveStored(page.userId, page.userName, myLists, order); } catch (err) {}
        }).then(function (ids) {
          list.ids = ids;
          saveStored(page.userId, page.userName, myLists, order);
          var count = Object.keys(ids).length;
          show('Loaded ' + index + '/' + myLists.length + '  ' + list.name + '  (' + count + ')');
          return next();
        }, function (err) {
          failed.push(list.name + ': ' + (err && err.message ? err.message : err));
          return next();
        });
      }
      return next();
    });
  }

  function loadOne(list, userId, show, keep) {
    if (list.id === RATINGS) return loadRatings(userId, show, keep);
    if (list.id === WATCHLIST) return collectPredefined('WATCH_LIST', userId);
    if (list.id === CHECKINS) return collectPredefined('CHECK_INS', userId);
    return loadCustomList(list, show);
  }

  function collectRatingsFast(userId, onCount) {
    var ids = {};
    var after = null;
    var pages = 0;
    var total = 0;
    var query = [
      'query ($userId: ID!, $after: String) {',
      '  userRatings(first: 1000, userId: $userId, after: $after) {',
      '    total',
      '    pageInfo { hasNextPage endCursor }',
      '    edges {',
      '      node {',
      '        title { id ratingsSummary { aggregateRating } }',
      '        userRating { value }',
      '      }',
      '    }',
      '  }',
      '}'
    ].join('\n');
    function step() {
      if (pages >= 80) return Promise.resolve({ ids: ids, total: total, done: false });
      pages += 1;
      return gql(query, { userId: userId, after: after }).then(function (json) {
        var conn = json.data && json.data.userRatings;
        if (!conn) throw new Error(firstError(json) || 'Could not read your ratings');
        (conn.edges || []).forEach(function (edge) {
          var node = edge && edge.node;
          var title = node && node.title;
          var code = title && encodeConst(title.id);
          if (!code) return;
          var mine = node.userRating && node.userRating.value;
          var imdb = title.ratingsSummary && title.ratingsSummary.aggregateRating;
          ids[code] = { m: mine || '', i: imdb || '' };
        });
        total = conn.total || total;
        if (onCount) onCount(Object.keys(ids).length, total, ids);
        var finished = !conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor;
        if (finished) {
          var count = Object.keys(ids).length;
          return { ids: ids, total: total, done: !total || count >= total };
        }
        after = conn.pageInfo.endCursor;
        return step();
      });
    }
    return step();
  }

  function continueRatingsCursor(cursor, ids, onCount) {
    var after = cursor;
    var pages = 0;
    var query = [
      'query ($after: String) {',
      '  advancedTitleSearch(first: 1000, after: $after) {',
      '    total',
      '    pageInfo { hasNextPage endCursor }',
      '    edges { node { title { id ratingsSummary { aggregateRating } } } }',
      '  }',
      '}'
    ].join('\n');
    function step() {
      if (!after || pages >= 80) return Promise.resolve(ids);
      pages += 1;
      return gql(query, { after: after }).then(function (json) {
        var conn = json.data && json.data.advancedTitleSearch;
        if (!conn || !(conn.edges || []).length) return ids;
        var before = Object.keys(ids).length;
        storeTitleEdges(ids, conn.edges);
        if (onCount) onCount(Object.keys(ids).length, conn.total || 0, ids);
        if (Object.keys(ids).length === before) return ids;
        if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return ids;
        after = conn.pageInfo.endCursor;
        return step();
      }, function () {
        return ids;
      });
    }
    return step();
  }

  function collectRatingsPages(path, options) {
    options = options || {};
    return readListPayload(path).then(function (first) {
      var ids = {};
      if (!first.hasList) return { ids: ids, hasList: false, total: 0 };
      var listPath = first.finalPath || path;
      var pageSize = first.titleEdges.length || 250;
      storeTitleEdges(ids, first.titleEdges);
      var total = first.total || Object.keys(ids).length;
      var lastPage = Math.max(1, Math.ceil(total / pageSize));
      if (lastPage > MAX_HTML_PAGES) lastPage = MAX_HTML_PAGES;
      var cursor = first.endCursor || '';
      var seenFirst = {};
      var firstTitle = titleFromEdge(first.titleEdges[0]);
      if (firstTitle) seenFirst[firstTitle.id] = true;
      if (options.onCount) options.onCount(Object.keys(ids).length, total, ids);
      var nextPage = 2;
      var misses = 0;
      function runBatch() {
        if (nextPage > lastPage || misses >= 3) return Promise.resolve();
        var page = nextPage;
        nextPage += 1;
        return readListPayload(pageOnly(listPath, page)).then(function (pack) {
          var before = Object.keys(ids).length;
          var marker = titleFromEdge(pack.titleEdges[0]);
          if (!pack.titleEdges.length || (marker && seenFirst[marker.id] && pack.titleEdges.length)) {
            misses += 1;
            return runBatch();
          }
          misses = 0;
          if (marker) seenFirst[marker.id] = true;
          storeTitleEdges(ids, pack.titleEdges);
          if (pack.endCursor) cursor = pack.endCursor;
          if (pack.total && pack.total > total) {
            total = pack.total;
            lastPage = Math.min(MAX_HTML_PAGES, Math.max(lastPage, Math.ceil(total / pageSize)));
          }
          if (options.onCount) options.onCount(Object.keys(ids).length, total, ids);
          if (Object.keys(ids).length === before) misses += 1;
          return runBatch();
        }, function () {
          misses += 1;
          if (options.onCount) options.onCount(Object.keys(ids).length, total, ids);
          return runBatch();
        });
      }
      return runBatch().then(function () {
        return { ids: ids, hasList: true, total: total, cursor: cursor };
      });
    });
  }

  function loadCustomList(list, show) {
    return collectEntireList('/list/' + list.id + '/', {
      list: list,
      onCount: function (count, total) {
        if (show) show(list.name + '  ' + count + (total ? ' / ' + total : ''));
      }
    }).then(function (page) {
      if (page.hasList && Object.keys(page.ids).length) return page.ids;
      if (list.type === PEOPLE) return collectNames(list.id);
      return collectTitles(list.id);
    });
  }

  function loadRatings(userId, show, keep) {
    var savedAt = 0;
    function note(count, total, ids) {
      if (show) show('Your ratings  ' + count + (total ? ' / ' + total : ''));
      if (keep && ids && count - savedAt >= 1000) {
        savedAt = count;
        keep(ids);
      }
    }
    return collectRatingsFast(userId, note).then(function (remote) {
      var count = Object.keys(remote.ids).length;
      if (count && (remote.done || (remote.total && count >= remote.total))) return remote.ids;
      return collectRatingsPages('/user/' + userId + '/ratings/', { onCount: note }).then(function (page) {
        Object.keys(page.ids).forEach(function (code) {
          if (!remote.ids[code]) remote.ids[code] = page.ids[code];
        });
        var have = Object.keys(remote.ids).length;
        var goal = Math.max(page.total || 0, remote.total || 0);
        if (!page.cursor || (goal && have >= goal)) return remote.ids;
        return continueRatingsCursor(page.cursor, remote.ids, note);
      });
    }, function () {
      return collectRatingsPages('/user/' + userId + '/ratings/', { onCount: note }).then(function (page) {
        if (page.cursor && (!page.total || Object.keys(page.ids).length < page.total)) {
          return continueRatingsCursor(page.cursor, page.ids, note);
        }
        if (Object.keys(page.ids).length) return page.ids;
        return collectRatings(userId);
      });
    });
  }

  function buildIndex(stored) {
    var myLists = stored.myLists || [];
    var order = stored.listOrder && stored.listOrder.length ? stored.listOrder : orderIndexes(myLists);
    var maps = {};
    maps[TITLES] = new Map();
    maps[PEOPLE] = new Map();

    myLists.forEach(function (list, listIndex) {
      var map = maps[list.type];
      if (!map || !list.ids) return;
      Object.keys(list.ids).forEach(function (code) {
        var rec = map.get(code);
        if (!rec) {
          rec = { color: '', lines: [], imdb: '' };
          map.set(code, rec);
        }
        var entry = list.ids[code] || {};
        var text = list.name;
        if (list.name === 'Your ratings' && entry.m) {
          text = 'Your ratings: ' + entry.m;
          if (entry.i) text += ' (IMDb: ' + entry.i + ')';
        }
        if (entry.i && !rec.imdb) rec.imdb = entry.i;
        rec.lines.push({ name: list.name, text: text, listIndex: listIndex });
      });
    });

    [TITLES, PEOPLE].forEach(function (type) {
      maps[type].forEach(function (rec) {
        for (var p = 0; p < order.length; p++) {
          var list = myLists[order[p]];
          if (!list || !list.color) continue;
          if (rec.lines.some(function (line) { return line.listIndex === order[p]; })) {
            rec.color = list.color;
            break;
          }
        }
      });
    });

    return maps;
  }

  function paint(el, color) {
    if (!el || !el.style) return;
    el.style.setProperty('color', color, 'important');
    el.style.setProperty('font-weight', '700', 'important');
  }

  function clearPaint(el) {
    if (!el || !el.style) return;
    el.style.removeProperty('background-color');
    el.style.removeProperty('color');
    el.style.removeProperty('font-weight');
    el.style.removeProperty('border-radius');
    if (!el.querySelectorAll) return;
    var kids = el.querySelectorAll('*');
    for (var i = 0; i < kids.length; i++) kids[i].style.removeProperty('color');
  }

  function ensureTip() {
    var tip = document.getElementById('imdb-mme-tip');
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'imdb-mme-tip';
    tip.style.cssText = [
      'position: fixed',
      'z-index: 100000',
      'display: none',
      'max-width: 420px',
      'padding: 6px 10px',
      'background: #333',
      'color: #fff',
      'font: 12px/1.45 Verdana, sans-serif',
      'pointer-events: none'
    ].join(';');
    document.documentElement.appendChild(tip);
    return tip;
  }

  function showTip(rec, event) {
    var tip = ensureTip();
    while (tip.firstChild) tip.removeChild(tip.firstChild);

    var rated = rec.lines.some(function (line) {
      return line.name === 'Your ratings' && line.text.indexOf('IMDb:') !== -1;
    });
    if (rec.imdb && !rated) {
      var imdb = document.createElement('div');
      imdb.textContent = 'IMDb rating: ' + rec.imdb;
      tip.appendChild(imdb);
    }

    var head = document.createElement('div');
    head.style.fontWeight = '700';
    head.textContent = rec.lines.length === 1
      ? 'In your list:'
      : 'In ' + rec.lines.length + ' of your lists:';
    tip.appendChild(head);

    rec.lines.forEach(function (line) {
      var row = document.createElement('div');
      row.style.marginLeft = '12px';
      row.textContent = line.text;
      tip.appendChild(row);
    });

    tip.style.display = 'block';
    moveTip(event);
  }

  function moveTip(event) {
    var tip = document.getElementById('imdb-mme-tip');
    if (!tip || tip.style.display === 'none') return;
    var x = event.clientX + 16;
    var y = event.clientY + 18;
    if (x + tip.offsetWidth > window.innerWidth - 8) x = Math.max(8, event.clientX - tip.offsetWidth - 12);
    if (y + tip.offsetHeight > window.innerHeight - 8) y = Math.max(8, event.clientY - tip.offsetHeight - 12);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hideTip() {
    var tip = document.getElementById('imdb-mme-tip');
    if (tip) tip.style.display = 'none';
  }

  function bindTip(el, rec) {
    if (el.dataset.mmeTip === '1') return;
    el.dataset.mmeTip = '1';
    el.addEventListener('mouseover', function (event) { showTip(rec, event); });
    el.addEventListener('mousemove', moveTip);
    el.addEventListener('mouseout', hideTip);
  }

  function highlightAnchor(anchor, maps) {
    if (!anchor || anchor.dataset.mme === '1') return;
    var path = anchor.pathname || '';
    var titleMatch = TITLE_PATH.exec(path);
    var nameMatch = !titleMatch && NAME_PATH.exec(path);
    if (!titleMatch && !nameMatch) return;
    anchor.dataset.mme = '1';
    var rec = titleMatch
      ? maps[TITLES].get(encodePathNumber(titleMatch[1]))
      : maps[PEOPLE].get(encodePathNumber(nameMatch[1]));
    if (!rec || !rec.color) return;
    paint(anchor, rec.color);
    bindTip(anchor, rec);
  }

  function highlightAdded(root, maps) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'A') highlightAnchor(root, maps);
    var anchors = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    for (var i = 0; i < anchors.length; i++) highlightAnchor(anchors[i], maps);
  }

  function highlightCurrentPage(maps) {
    var path = location.pathname;
    var titleMatch = TITLE_PATH.exec(path);
    var nameMatch = !titleMatch && NAME_PATH.exec(path);
    var rec = null;
    if (titleMatch) rec = maps[TITLES].get(encodePathNumber(titleMatch[1]));
    else if (nameMatch) rec = maps[PEOPLE].get(encodePathNumber(nameMatch[1]));
    if (!rec || !rec.color) return;
    var heading = document.querySelector('h1');
    if (!heading) return;
    paint(heading, rec.color);
    var span = heading.querySelector('span');
    if (span) paint(span, rec.color);
    bindTip(heading, rec);
  }

  var highlightObserver = null;

  function startHighlight(stored) {
    if (highlightObserver) highlightObserver.disconnect();
    var maps = buildIndex(stored);
    if (!maps[TITLES].size && !maps[PEOPLE].size) return;

    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) highlightAnchor(anchors[i], maps);
    highlightCurrentPage(maps);

    var pending = [];
    var scheduled = false;
    function flush() {
      scheduled = false;
      var batch = pending;
      pending = [];
      for (var n = 0; n < batch.length; n++) highlightAdded(batch[n], maps);
    }

    highlightObserver = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var nodes = mutations[m].addedNodes;
        for (var n = 0; n < nodes.length; n++) {
          if (nodes[n].nodeType === 1) pending.push(nodes[n]);
        }
      }
      if (!scheduled && pending.length) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    });
    highlightObserver.observe(document.body, { childList: true, subtree: true });
  }

  function rehighlight(userId) {
    var stored = loadStored(userId);
    if (!stored) return;
    var marked = document.querySelectorAll('[data-mme]');
    for (var i = 0; i < marked.length; i++) {
      delete marked[i].dataset.mme;
      clearPaint(marked[i]);
    }
    startHighlight(stored);
  }

  function maybeAutoRefresh() {
    if (!isLoggedIn()) return;
    var userId = localStorage.getItem('myMovies-active-user');
    if (!userId) return;
    var last = Number(localStorage.getItem('myMovies-refreshed-at') || 0);
    if (!last || Date.now() - last < DAY_MS) return;
    var lock = Number(localStorage.getItem('myMovies-refresh-lock') || 0);
    if (lock && Date.now() - lock < 10 * 60 * 1000) return;
    localStorage.setItem('myMovies-refresh-lock', String(Date.now()));
    refreshData({
      userId: userId,
      userName: localStorage.getItem('myMovies-active-name') || ''
    }, function () {}).then(function () {
      localStorage.removeItem('myMovies-refresh-lock');
      rehighlight(userId);
    }, function () {
      localStorage.removeItem('myMovies-refresh-lock');
    });
  }

  var onListsPage = LISTS_PATH.test(location.pathname);
  if (onListsPage) {
    try {
      var listsPage = readListsPage();
      if (listsPage && listsPage.isOwner && listsPage.userId) installListsPage(listsPage);
    } catch (err) {
      console.error('IMDb Lists Marker', err);
    }
  }

  if (!isLoggedIn()) return;
  var activeUser = localStorage.getItem('myMovies-active-user');
  if (!activeUser) return;
  var stored = loadStored(activeUser);
  if (!stored) return;
  startHighlight(stored);
  maybeAutoRefresh();
})();
