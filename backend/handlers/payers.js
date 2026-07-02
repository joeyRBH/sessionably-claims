'use strict';

// Payers resource — one Lambda, one route:
//
//   GET /payers/search?q=<fragment>  → type-ahead payer lookup via Stedi's
//                                      Search Payers API.
//
// Auth required (any active session). No PHI is involved: the only input is a
// free-text payer-name fragment and the response is public payer-directory data,
// so nothing is scoped to a practice and nothing is persisted here.

const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const stedi = require('../lib/clearinghouse/stedi');

// HTTP method, tolerant of both API Gateway payload formats (v1 httpMethod,
// v2 requestContext.http.method).
function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }
  if (method !== 'GET') {
    return json(405, { error: 'Method not allowed' }, event);
  }

  try {
    requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  const q = (queryParam(event, 'q') || '').trim();
  if (q.length < 2 || q.length > 200) {
    return json(400, { error: 'Query must be between 2 and 200 characters.' }, event);
  }

  try {
    const payers = await stedi.searchPayers(q);
    return json(200, { payers }, event);
  } catch (err) {
    // No PHI in a payer-name search; log only the message and return a clean error.
    console.error('payers search error:', err && err.message);
    return json(502, { error: 'Could not search payers.' }, event);
  }
};
