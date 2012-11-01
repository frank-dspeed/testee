var _ = require('underscore');
var fs = require('fs');
var connect = require('connect');
var url = require('url');
var path = require('path');
var mocha = require('mocha');
var async = require('async');
var winston = require('winston');

var Server = require('./server');
var Converter = require('./converter');
var launchpad = require('launchpad');
var miner = require('miner');
var utils = require('./utils');
var logger = utils.getLogger();

var createTunnel = function (config, callback) {
	var settings = { port : config.port };
	var type = config.tunnel.type || config.tunnel;
	if (_.isObject(config.tunnel)) {
		_.extend(settings, config.tunnel);
	}

	miner[type](settings, callback);
}

var launch = function (url, config, callback) {
	var launcherSettings = typeof config.launch === 'string' ? {} : config.launch;
	var type = config.launch.type || config.launch;
	var browserSettings = _.isObject(config.browser) ? config.browser : { browser : config.browser };
	launchpad[type](launcherSettings, function (error, launcher) {
		if (error) return callback(error);

		launcher(url, browserSettings, callback);
	});
}

var defaults = {
	launch : 'local', // local, remote, browserstack
	tunnel : 'local', // local, localtunnel, pagekite
	browser : 'phantom',
	root : '.', // HTTP server root
	reporter : 'Spec',
	port : 3996,
	verbose : true,
	log : './testee.log',
	timeout : 10
}

var test = function (file, configuration, callback) {
	var files = Array.isArray(file) ? file : [file];
	var config = _.extend({}, defaults, configuration);
	var server = Server.createServer(_.extend(_.pick(config, 'root'), config.server));

	if (config.verbose) {
		logger.add(winston.transports.File, {
			filename : config.log,
			json : false,
			handleExceptions : true
		});
	}

	config.root = fs.realpathSync(config.root);

	// First thing: Create the tunnel
	createTunnel(_.pick(config, 'port', 'tunnel'), function (error, hostUrl, proc) {
		if (error) return callback(error);

		// Create a callback list for each test file
		var tests = files.map(function (filename) {
			return function (callback) {
				if (!utils.validateFilename(config.root, filename)) {
					return callback(new Error(filename + ' does not seem to be within the root directory'));
				}

				var getParams = function (token) {
					var result = {};
					result[server.config.token] = token;
					return result;
				}

				// Create a new token. Make sure it's not already registered
				var token = utils.generateToken(_.keys(server.emitters));
				// Based on the token, the tunnel URL and the filename we can create the actual URL
				// for launching the browser
				var url = utils.getUrl(hostUrl, file, getParams(token));
				// Launch the browser
				launch(url, _.pick(config, 'launch', 'browser'), function (error, instance) {
					if (error) return callback(error);

					var timeout = setTimeout(function () {
						instance.stop(function () {
							callback(new Error('Browser instance ' + (config.browser.browser || config.browser) +
								' timed out after ' + config.timeout + ' seconds'));
						});
					}, config.timeout * 1000);

					server.register(token, instance);
					instance.on('testing', function (reporter) {
						// TODO per test timeout?
						clearTimeout(timeout);
						logger.log('Got test reporter for token ' + token);
						var convertedReporter = new Converter(reporter);
						new mocha.reporters[config.reporter](convertedReporter);
						reporter.on(server.config.exitEvent, function () {
							instance.on('stop', function (status) {
								logger.log('Stopped instance', status);
							});
							instance.stop();
							callback();
						});
					});
				});
			}
		});

		// We can only do serial testing at the moment`
		async.series(tests, function (error, results) {
			callback(error, results);
			// TODO try and shut the server down gracefully
			// process.exit();
		});
	});

	server.listen(config.port);
}

module.exports = {
	Server : Server,
	createTunnel : createTunnel,
	defaults : defaults,
	launch : launch,
	test : test
}