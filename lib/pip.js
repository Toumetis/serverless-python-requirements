const fse = require('fs-extra');
const rimraf = require('rimraf');
const path = require('path');
const get = require('lodash.get');
const set = require('lodash.set');
const {spawnSync} = require('child_process');
const values = require('lodash.values');
const {buildImage, getBindPath, getDockerUid} = require('./docker');


/**
 * Run a command, either in docker or native
 * @param {string[]} commandAndArguments
 * @param {string} requirementsPath
 * @param {string} targetFolder
 * @param {Object} serverless
 * @param {string} servicePath
 * @param {Object} options
 * @return {undefined}
 */
function executeCommand(commandAndArguments, serverless, servicePath, options, useShellAlways) {
  let cmd;
  let cmdOptions;

  if (options.dockerizePip) {
    cmd = 'docker';

    // Build docker image if required
    let dockerImage;
    if (options.dockerFile) {
      serverless.cli.log(`Building custom docker image from ${options.dockerFile}...`);
      dockerImage = buildImage(options.dockerFile);
    } else {
      dockerImage = options.dockerImage;
    }
    serverless.cli.log(`Docker Image: ${dockerImage}`);

    // Prepare bind path depending on os platform
    const bindPath = getBindPath(servicePath);

    cmdOptions = [
      'run', '--rm',
      '-v', `${bindPath}:/var/task:z`,
    ];
    if (options.dockerSsh) {
      // Mount necessary ssh files to work with private repos
      cmdOptions.push('-v', `${process.env.HOME}/.ssh/id_rsa:/root/.ssh/id_rsa:z`);
      cmdOptions.push('-v', `${process.env.HOME}/.ssh/known_hosts:/root/.ssh/known_hosts:z`);
      cmdOptions.push('-v', `${process.env.SSH_AUTH_SOCK}:/tmp/ssh_sock:z`);
      cmdOptions.push('-e', 'SSH_AUTH_SOCK=/tmp/ssh_sock');
    }
    if (process.platform === 'linux') {
      // Use same user so requirements folder is not root and so --cache-dir works
      cmdOptions.push('-u', `${process.getuid()}`);
      // const stripCmd = quote([
      //   'find', targetRequirementsFolder,
      //   '-name', '"*.so"',
      //   '-exec', 'strip', '{}', '\;',
      // ]);
      // pipCmd = ['/bin/bash', '-c', '"' + pipCmd + ' && ' + stripCmd + ' && ' + chownCmd + '"'];
    } else {
      // Use same user so --cache-dir works
      cmdOptions.push('-u', getDockerUid(bindPath));
    }
    cmdOptions.push(dockerImage);

    if (useShellAlways) {
      cmdOptions.push('/bin/bash', '-c', `'${commandAndArguments.join(' ')}'`);
    } else {
      cmdOptions.push(...commandAndArguments);
    }
  } else {
    cmd = commandAndArguments[0];
    cmdOptions = commandAndArguments.slice(1);
  }

  serverless.cli.log(`running ${cmd} ${cmdOptions.join(' ')}`);

  const res = spawnSync(cmd, cmdOptions, { cwd: servicePath, shell: true });

  if (options.verbose && res.stdout) {
    let outText = res.stdout.toString();
    if (outText) 
      serverless.cli.log(outText);
  }
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      if (options.dockerizePip) {
        throw new Error('docker not found! Please install it.');
      }
      throw new Error(`${options.pythonBin} not found! Try the pythonBin option.`);
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(res.stderr);
  }
}


/**
 * Install requirements described in requirementsPath to targetFolder
 * @param {string} requirementsPath
 * @param {string} targetFolder
 * @param {Object} serverless
 * @param {string} servicePath
 * @param {Object} options
 * @return {undefined}
 */
function installRequirements(requirementsPath, targetFolder, serverless, servicePath, options) {
  // Create target folder if it does not exist
  const targetRequirementsFolder = path.join(targetFolder, 'requirements');
  fse.ensureDirSync(targetRequirementsFolder);

  const dotSlsReqs = path.join(targetFolder, 'requirements.txt');
  if (options.usePipenv && fse.existsSync(path.join(servicePath, 'Pipfile'))) {
    generateRequirementsFile(dotSlsReqs, dotSlsReqs, options);
  } else {
    generateRequirementsFile(requirementsPath, dotSlsReqs, options);
  }

  serverless.cli.log(`Installing requirements of ${requirementsPath} in ${targetFolder}...`);

  let pipCmd = [
    options.pythonBin, '-m', 'pip', '--isolated', 'install',
    '-t', dockerPathForWin(options, targetRequirementsFolder),
    '-r', dockerPathForWin(options, dotSlsReqs),
    ...options.pipCmdExtraArgs,
  ];
  executeCommand(pipCmd, serverless, servicePath, options)
};

function runPostInstallScript(command, cmdArgs, targetFolder, serverless, servicePath, options) {
  
  const targetRequirementsFolder = path.join(targetFolder, 'requirements');
  cmdArgs = cmdArgs || [];

  let cmd = [
    command,
    targetRequirementsFolder,
    ...cmdArgs
  ]

  executeCommand(cmd, serverless, servicePath, options, true)
}

/**
 * convert path from Windows style to Linux style, if needed
 * @param {Object} options
 * @param {string} path
 * @return {string}
 */
function dockerPathForWin(options, path) {
  if (process.platform === 'win32' && options.dockerizePip) {
    return path.replace('\\', '/');
  }
  return path;
}

/** create a filtered requirements.txt without anything from noDeploy
 * @param {string} source requirements
 * @param {string} target requirements where results are written
 * @param {Object} options
 */
function generateRequirementsFile(source, target, options) {
  const noDeploy = new Set(options.noDeploy || []);
  const requirements = fse.readFileSync(source, {encoding: 'utf-8'}).split(/\r?\n/);
  const filteredRequirements = requirements.filter((req) => {
    return !noDeploy.has(req.split(/[=<> \t]/)[0].trim());
  });
  fse.writeFileSync(target, filteredRequirements.join('\n'));
}

/**
 * Copy everything from vendorFolder to targetFolder
 * @param {string} vendorFolder
 * @param {string} targetFolder
 * @param {Object} serverless
 * @return {undefined}
 */
function copyVendors(vendorFolder, targetFolder, serverless) {
  // Create target folder if it does not exist
  const targetRequirementsFolder = path.join(targetFolder, 'requirements');

  serverless.cli.log(
    `Copying vendor libraries from ${vendorFolder} to ${targetRequirementsFolder}...`);

  fse.readdirSync(vendorFolder).map((file) => {
    let source = path.join(vendorFolder, file);
    let dest = path.join(targetRequirementsFolder, file);
    if (fse.existsSync(dest)) {
      rimraf.sync(dest);
    }
    fse.copySync(source, dest);
  });
}

/**
 * pip install the requirements to the .serverless/requirements directory
 * @return {undefined}
 */
function installAllRequirements() {
  fse.ensureDirSync(path.join(this.servicePath, '.serverless'));
  if (this.serverless.service.package.individually) {
    let doneModules = [];
    values(this.serverless.service.functions)
      .forEach((f) => {
        if (!get(f, 'module')) {
          set(f, ['module'], '.');
        }
        if (!doneModules.includes(f.module)) {
          installRequirements(
            path.join(f.module, this.options.fileName),
            path.join('.serverless', f.module),
            this.serverless,
            this.servicePath,
            this.options
          );
          if (f.vendor) {
            // copy vendor libraries to requirements folder
            copyVendors(
              f.vendor,
              path.join('.serverless', f.module),
              this.serverless
            );
          }
          if (f.pipPostInstallScript) {
            runPostInstallScript(
              f.pipPostInstallScript,
              f.pipPostInstallArgs,
              path.join('.serverless', f.module),
              this.serverless,
              this.servicePath,
              this.options
            )
          }
          doneModules.push(f.module);
        }
      });
  } else {
    installRequirements(
      this.options.fileName,
      '.serverless',
      this.serverless,
      this.servicePath,
      this.options
    );
    if (this.options.vendor) {
      // copy vendor libraries to requirements folder
      copyVendors(
        this.options.vendor,
        '.serverless',
        this.serverless
      );
    }
    if (this.options.pipPostInstallScript) {
      runPostInstallScript(
        this.options.pipPostInstallScript,
        this.options.pipPostInstallArgs,
        '.serverless',
        this.serverless,
        this.servicePath,
        this.options
      )
    }
  }
};

module.exports = {installAllRequirements};
