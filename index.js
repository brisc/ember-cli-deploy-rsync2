/* jshint node: true */
/* predef Promise */
'use strict';

const BasePlugin = require('ember-cli-deploy-plugin');
const Rsync = require('rsync');
const username = require('username');
const fullname = require('fullname');
const tmp = require('tmp');
const fs = require('fs');
const sysPath = require('path');
const childProcess = require('child_process');

const hasOwn = Object.prototype.hasOwnProperty;

function removeTrailingSlash(path) {
  return path.replace(/[\/\\]?$/, '');
}

function unlinkCleanup(file, callback) {
  const cleanup = function () {
    silentlyFail(fs.unlinkSync.bind(fs, file));
    if (callback) {
      callback.apply(null, arguments);
    }
  };
  if (!callback) {
    cleanup();
  } else {
    return cleanup;
  }
}

function silentlyFail(callback) {
  try {
    return {
      return: callback()
    };
  } catch (e) {
    return {
      error: e
    };
  }
}

module.exports = {
  name: 'ember-cli-deploy-rsync2',

  createDeployPlugin(options) {
    let configCache;

    const DeployPlugin = BasePlugin.extend({
      name: options.name,

      defaultConfig: {
        port: '22',
        sourcePath: 'tmp/deploy-dist',
        currentPath: 'current',
        revisionsFile: 'revisions.json',
        exclude: null,
        include: null,
        flags: 'rtu',
        deployerFormat: '{user}',
      },

      requiredConfig: ['username', 'releasesPath', 'host'],


      configure() {
        this._super();
        this._addDebug('Checking that git working directory is clean...');

        [ 'revisionKey', 'didDeployMessage'].forEach(this.applyDefaultConfigProperty.bind(this));
        return new Promise(function (resolve, reject) {
          childProcess.exec('git diff-index --quiet HEAD --', function (err) {
            if (err) {
              return reject('Git working directory is not clean, commit any change before using `ember deploy`');
            }
            resolve();
          });
        });
      },

      didPrepare(context) {
        this._addDebug('Ensuring that revision data is present in the deploy context...');
        if (!context.revisionData) {
          return Promise.reject(
            'You must include `ember-cli-deploy-revision-data` plugin for `' + options.name + '` to work.'
          );
        }
      },
      didDeployMessage: function(context){
        var revisionKey = context.revisionData && context.revisionData.revisionKey;
        var activatedRevisionKey = context.revisionData && context.revisionData.activatedRevisionKey;
        if (revisionKey && !activatedRevisionKey) {
          return "Deployed but did not activate revision " + revisionKey + ". "
            + "To activate, run: "
            + "ember deploy:activate " + context.deployTarget + " --revision=" + revisionKey + "\n";
        }
      },

      revisionKey: function(context) {
        return context.commandOptions.revision || (context.revisionData && context.revisionData.revisionKey);
      },
      didDeploy: function (/* context */) {
        var didDeployMessage = this.readConfig('didDeployMessage');
        if (didDeployMessage) {
          this._addInfo(didDeployMessage);
        }
      },


      fetchInitialRevisions() {
        return this._grabRevisionsList()
          .then(function (revisions) {
            return {
              initialRevisions: revisions
            };
          });
      },

      fetchRevisions() {
        return this._grabRevisionsList()
          .then(function (revisions) {
            return {
              revisions: revisions.sort(function(a,b){
                return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
              })
            };
          });
      },

      _addDebug(message) {
        return this.log(message, {
          verbose: true
        });
      },

      _addInfo(message) {
        return this.log(message);
      },

      _config() {
        if (!configCache) {
          this._addDebug('Building configuration cache...');
          const releasesPath = removeTrailingSlash(this.readConfig('releasesPath'));
          const currentPath = this.readConfig('currentPath');

          configCache = {
            currentPath: sysPath.isAbsolute(currentPath) ? sysPath.relative(releasesPath, currentPath) : currentPath,
            currentBase: sysPath.basename(currentPath),
            releasesPath: releasesPath,
            sourcePath: removeTrailingSlash(this.readConfig('sourcePath')),
            revisionsFile: releasesPath + '/' + this.readConfig('revisionsFile'),
            username: this.readConfig('username'),
            host: this.readConfig('host'),
            port: this.readConfig('port'),
            userAtHost: this.readConfig('username') + '@' + this.readConfig('host'),
            flags: this.readConfig('flags'),
            exclude: this.readConfig('exclude'),
            include: this.readConfig('include'),
            deployerFormat: this.readConfig('deployerFormat') || 'unknown',
          };
        }
        return configCache;
      },

      _grabRevisionsList() {
        const plugin = this;
        const config = this._config();
        this._addDebug('Grabbing revision list from the server...');
        return new Promise(function (resolve, reject) {
          const path = tmp.tmpNameSync({
            postfix: '.json'
          });
          plugin._rsync(
              config.userAtHost + ':' + config.revisionsFile,
            path,
            't'
            )
            .then(function () {
              return require(path).data;
            })
            .then(unlinkCleanup(path, resolve))
            .catch(function (err) {
              // invalid path, we are sure it's a missing file and so can create one
              unlinkCleanup(path);
              if (err.message === 'rsync exited with code 23') {
                resolve([]);
              } else {
                reject(err);
              }
            });
        });
      },

      _rsync(source, destination, options) {
        const config = this._config();
        const rsync = new Rsync()
          .shell('ssh -p ' + config.port)
          .source(source)
          .destination(destination);

        if (typeof options === 'string') {
          options = {
            flags: options
          };
        } else if (options == null) {
          options = {
            flags: config.flags,
            exclude: config.exclude,
            include: config.include,
          };
        }

        // apply options
        rsync.flags(options.flags);
        if (options.exclude || options.include) {
          rsync.set('exclude', options.exclude || '*');
          if (options.include) {
            rsync.set('include', options.include);
          }
        }

        this._addDebug('Running rsync command: ' + rsync.command());

        return new Promise(function (resolve, reject) {
          rsync.execute(function (error /*, code, cmd*/) {
            return error ? reject(error) : resolve();
          });
        });
      },

      _uploadRevisionsFile(revisions) {
        const plugin = this;
        const config = this._config();

        this._addDebug('Uploading revisions file...');

        return new Promise(function (resolve, reject) {
          const path = tmp.tmpNameSync({
            postfix: '.json'
          });
          try {
            fs.writeFileSync(path, JSON.stringify({
              data: revisions
            }));
          } catch (err) {
            return unlinkCleanup(path, reject)(err);
          }
          plugin._rsync(
            path,
              config.userAtHost + ':' + config.revisionsFile,
            't'
            )
            .then(unlinkCleanup(path, resolve))
            .catch(unlinkCleanup(path, reject));
        });
      },

      _activateRevision(revision) {
        const plugin = this;
        const config = this._config();
        const currentPath = sysPath.resolve(config.releasesPath, config.currentPath);
        const revPath = config.releasesPath + '/' + revision;
        const link = sysPath.relative(sysPath.dirname(currentPath), revPath);

        this._addInfo('Activating revision `' + revision + '`...');

        return new Promise(function (resolve, reject) {
          tmp.dir({
            unsafeCleanup: true
          }, function (err, path, cleanupCallback) {
            if (err) {
              return reject(err);
            }
            fs.symlink(link, sysPath.join(path, config.currentBase), 'dir', function (err) {
              if (err) {
                silentlyFail(cleanupCallback);
                return reject(err);
              }
              plugin._rsync(path + '/*', config.userAtHost + ':' + sysPath.dirname(currentPath) + '/', 'rltI')
                .then(function () {
                  silentlyFail(cleanupCallback);
                  resolve();
                })
                .catch(function (err) {
                  silentlyFail(cleanupCallback);
                  reject(err);
                });
            });

          });
        });
      },

      _formatDeployer(format, revisionData) {
        const map = Object.assign({}, revisionData || {});
        return fullname().then(function (name) {
          map.userFullName = name;
          map.userName = username.sync();
          map.user = name || map.userName;
          return format.replace(/\{([a-z0-9]+)}/gi, function (dummy, key) {
            if (hasOwn.call(map, key)) {
              return map[key];
            }
            return '{' + key + '}';
          });
        });
      },

      activate(context) {
        let revisionKey = this.revisionKey(context);
        return this._activateRevision(revisionKey);
      },

      upload(context) {
        const plugin = this;
        const config = this._config();
        const rev = context.revisionData;
        const revPath = config.releasesPath + '/' + rev.revisionKey;
        const revisions = context.initialRevisions.filter(function (r) {
          return r.revision !== rev.revisionKey;
        }).map(function (r) {
          return Object.assign({}, r, {
            active: false
          });
        });
        let revision;

        return this._formatDeployer(config.deployerFormat, rev)
          .then(function (deployer) {
            revisions.push(revision = {
              version: rev.scm.sha,
              timestamp: rev.timestamp,
              revision: rev.revisionKey,
              active: true,
              deployer: deployer,
            });

            plugin._addInfo('Uploading revision `' + rev.revisionKey + '` (deployer: ' + revision.deployer + ')...');

            return Promise.all([
              plugin._rsync(
                config.sourcePath + '/',
                config.userAtHost + ':' + revPath + '/'
              ),
              plugin._uploadRevisionsFile(revisions),
            ]);
          });
      },
    });

    return new DeployPlugin();
  }
};
