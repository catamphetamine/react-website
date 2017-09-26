// produces wrong line numbers:
// import 'source-map-support/register'

import React from 'react'
import ReactDOM from 'react-dom/server'

import { Readable } from 'stream'

// https://github.com/ReactTraining/react-router/issues/4023
// Also adds `useBasename` and `useQueries`
import createHistory from 'react-router/lib/createMemoryHistory'

import { render_before_content, render_after_content } from './html'
import normalize_common_settings from '../redux/normalize'
import timer from '../timer'
import create_history from '../history'
import { location_url, parse_location } from '../location'

import redux_render, { initialize as redux_initialize } from '../redux/server/server'
import { render_on_server as react_router_render } from '../react-router/render'

import { Preload } from '../redux/actions'

// Since `react-helmet` relies on React rendering to be synchronous
// `ReactDOM.renderToString()` is used here instead of
// the more performant `ReactDOM.renderToNodeStream(element)`.
//
// https://github.com/nfl/react-helmet/issues/240
// 
// If some day a concurrency-safe alternative to `react-helmet` is found
// then it will be possible to switch to streamed React rendering.
//
// const streaming = ReactDOM.renderToNodeStream ? true : false
//
const streaming = false

// isomorphic (universal) rendering (middleware).
// will be used in web_application.use(...)
export default async function(settings, { initialize, localize, assets, application, proxy, request, render, loading, html = {}, cookies, beforeRender })
{
	// Legacy `application` option will be removed in a future major release
	proxy = proxy || application
	
	settings = normalize_common_settings(settings)

	const
	{
		routes,
		wrapper,
		authentication
	}
	= settings

	const error_handler = settings.error

	// If Redux is being used, then render for Redux.
	// Else render for pure React.
	const render_page = redux_render

	// Read protected cookie value (if configured)
	let protected_cookie_value
	if (authentication && authentication.protectedCookie)
	{
		protected_cookie_value = cookies.get(authentication.protectedCookie)
	}

	// `history` is created after the `store`.
	// At the same time, `store` needs the `history` later during navigation.
	// And `history` might need store for things like `react-router-redux`.
	// Hence the getter instead of a simple variable
	let history
	const get_history = () => history

	const initialize_timer = timer()

	// `parameters` are used for `assets`, `html` modifiers and also for `localize()` call.
	const { extension_javascript, afterwards, ...parameters } = await redux_initialize(settings,
	{
		protected_cookie_value,
		proxy,
		request,
		cookies,
		initialize,
		get_history
	})

	const normalize_result = (result) => _normalize_result(result, afterwards, settings)

	// Create `history` (`true` indicates server-side usage).
	// Koa `request.url` is not really a URL,
	// it's a URL without the `origin` (scheme, host, port).
	history = create_history(createHistory, request.url, settings.history, parameters, true)

	const location = history.getCurrentLocation()
	const path     = location.pathname

	// The above code (server-side `initialize()` method call) is not included
	// in this `try/catch` block because:
	//
	//  * `parameters` are used inside `.error()`
	//
	//  * even if an error was caught inside `initialize()`
	//    and a redirection was performed, say, to an `/error` page
	//    then it would fail again because `initialize()` would get called again,
	//    so wrapping `initialize()` with `try/catch` wouldn't help anyway.
	//
	try
	{
		const initialize_time = initialize_timer()

		// Internationalization

		let locale
		let messages
		let messagesJSON

		if (localize)
		{
			// `localize()` should normally be a synchronous function.
			// It could be asynchronous though for cases when it's taking
			// messages not from a JSON file but rather from an
			// "admin" user editable database.
			// If the rountrip time (ping) from the rendering service
			// to the database is small enough then it theoretically
			// won't introduce any major page rendering latency
			// (the database will surely cache such a hot query).
			// On the other hand, if a developer fights for each millisecond
			// then `localize()` should just return `messages` from memory.

			let result = localize(parameters)

			// If `localize()` returned a `Promise` then wait for it
			if (typeof result.then === 'function')
			{
				result = await result
			}

			locale   = result.locale
			messages = result.messages

			// A tiny optimization to avoid calculating
			// `JSON.stringify(messages)` for each rendered page:
			// `localize()` can return a cached `messagesJSON` string
			// instead of `messages` JSON object
			// to further reduce internationalization-induced latency
			// by an extra millisecond or so (benchmark if interested)
			// by not stringifying `messages` JSON object for each page rendered.
			messagesJSON = result.messagesJSON || JSON.stringify(messages)
		}

		// Render the web page
		const result = await render_page
		({
			...parameters,
			disable_server_side_rendering: render === false,
			history,
			routes,
			streaming,
			before_render: beforeRender,

			create_page_element: (child_element, props) => 
			{
				if (localize)
				{
					props.locale   = locale
					props.messages = messages
				}

				return React.createElement(wrapper, props, child_element)
			},

			render_webpage(react_element_tree)
			{
				// For Redux:
				// `react_element_tree` is undefined if `render === false`.
				// Otherwise `react_element_tree` is `<Router>...</Router>`.

				// `html` modifiers

				let { head } = html
				// camelCase support for those who prefer it
				let body_start = html.body_start || html.bodyStart
				let body_end   = html.body_end   || html.bodyEnd

				// Normalize `html` parameters
				head       = render_to_a_string(typeof head       === 'function' ? head      (path, parameters) : head)
				body_start = render_to_a_string(typeof body_start === 'function' ? body_start(path, parameters) : body_start)
				body_end   = render_to_a_string(typeof body_end   === 'function' ? body_end  (path, parameters) : body_end)

				// Normalize assets
				assets = typeof assets === 'function' ? assets(path, parameters) : assets

				// Sanity check
				if (!assets.entries)
				{
					throw new Error(`"assets.entries" array parameter is required as of version 10.1.0. E.g. "{ ... entries: ['main'] ... }"`)
				}

				// Render page content
				const content = render === false ? render_to_a_string(loading) : render_react(react_element_tree)

				// Render all HTML that goes before React markup.
				// It is rendered after content has been
				// because that's how `react-helmet` works
				// (all that "rewind" stuff).
				const before_content = render_before_content
				({
					assets,
					locale,
					head,
					body_start
				})

				// Render all HTML that goes after React markup
				const after_content = render_after_content
				({
					extension_javascript: typeof extension_javascript === 'function' ? extension_javascript() : extension_javascript,
					assets,
					locale,
					locale_messages_json: messagesJSON,
					body_end,
					protected_cookie_value,
					server_side_rendering_enabled: render !== false
				})

				// // Returning a readable stream because some day
				// // `react-helmet` will be replaced with something asynchronous
				// // in which case streamed React rendering becomes available.
				//
				// import multistream from 'multistream'
				// return multistream
				// ([
				// 	text_stream(before_content),
				// 	typeof content === 'string' ? text_stream(content) : content,
				// 	text_stream(after_content)
				// ])
				//
				// return [
				// 	before_content,
				// 	typeof content === 'string' ? text_stream(content) : content,
				// 	after_content
				// ]

				// Returning a `String` for now, since some people could rely
				// on `render()` result having `content` which is a `String`.
				return before_content + content + after_content
			}
		})

		if (result.time)
		{
			result.time.initialize = initialize_time
		}

		return normalize_result(result)
	}
	catch (error)
	{
		// Redirection is sometimes done via an Error on server side.
		// (e.g. it can happen in `react-router`'s `onEnter()` during `match()`)
		if (error._redirect)
		{
			return normalize_result({ redirect: error._redirect })
		}

		if (error_handler)
		{
			const result = {}

			const error_handler_parameters =
			{
				path,
				url      : location_url(location),
				redirect : (to) =>
				{
					// Only the first redirect takes effect on the server side
					if (!result.redirect)
					{
						result.redirect = parse_location(to)
					}
				},
				server   : true
			}

			// Special case for Redux
			if (parameters.store)
			{
				error_handler_parameters.dispatch = redirecting_dispatch(parameters.store.dispatch, error_handler_parameters.redirect)
				error_handler_parameters.getState = parameters.store.getState
			}

			error_handler(error, error_handler_parameters)
		
			// Either redirects or throws the error
			if (result.redirect)
			{
				return normalize_result(result)
			}
		}

		throw error
	}
}

// Converts `React.Element`s to `String`s
function render_to_a_string(anything)
{
	if (!anything)
	{
		return ''
	}

	// If it's already a `String` then return it
	if (typeof anything === 'string')
	{
		return anything
	}

	// Recurse into arrays
	if (Array.isArray(anything))
	{
		return anything.map(render_to_a_string).join('')
	}

	// Render `React.Element` to a `String`
	return ReactDOM.renderToString(anything)
}

// A special flavour of `dispatch` which `throw`s for redirects on the server side.
function redirecting_dispatch(dispatch, redirect)
{
	return (event) =>
	{
		switch (event.type)
		{
			// In case of navigation from @preload()
			case Preload:
				// `throw`s a special `Error` on server side
				return redirect(event.location)
		
			default:
				// Proceed with the original
				return dispatch(event)
		}
	}
}

function _normalize_result(result, afterwards, settings)
{
	// Stringify `redirect` location
	if (result.redirect)
	{
		// Prepend `basename` to relative URLs for server-side redirect.
		result.redirect = location_url(result.redirect, { basename: settings.history.options.basename })
	}

	// Add `afterwards`
	result.afterwards = afterwards

	return result
}

// Renders React element into a `String` or a stream.
function render_react(element)
{
	if (!element)
	{
		return ''
	}

	if (streaming)
	{
		return ReactDOM.renderToNodeStream(element)
	}

	return ReactDOM.renderToString(element)
}

// Turns a `String` into a `Stream`
function text_stream(string)
{
	const stream = new Readable()
	stream.push(string)
	stream.push(null)
	return stream
}

// Just in case
function read_stream(stream)
{
	return new Promise((resolve, reject) =>
	{
		let result = ''
		stream.on('data', chunk => result += chunk)
		stream.on('end', () => resolve(result))
		stream.on('error', reject)
	})
}