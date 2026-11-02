{ lib, buildNpmPackage, nodejs_22, makeWrapper, claude-code }:

let
  # Angular UI, built separately because it has its own lockfile.
  web = buildNpmPackage {
    pname = "pr-manager-web";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ../web;
      fileset = lib.fileset.difference ../web (lib.fileset.maybeMissing ../web/node_modules);
    };
    nodejs = nodejs_22;
    npmDepsHash = "sha256-zR28aNp9DNFaVWXsaPazw1uyx5xifFesB9Ja7r0DH+0=";
    buildPhase = ''
      runHook preBuild
      npx ng build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      cp -r dist/web/browser $out
      runHook postInstall
    '';
  };
in
buildNpmPackage {
  pname = "pr-manager";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../package.json ../package-lock.json ../server ../prompts ];
  };
  nodejs = nodejs_22;
  npmDepsHash = "sha256-v5VWGzg2Xx7E9wCL4Mt4hfwCG2smF/48TQ7ble2/FSM=";
  npmInstallFlags = [ "--omit=dev" ];
  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  # Node runs the TypeScript sources directly (type stripping), so there is nothing to compile.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/pr-manager $out/bin
    cp -r package.json server prompts node_modules $out/lib/pr-manager/
    makeWrapper ${nodejs_22}/bin/node $out/bin/pr-manager-daemon \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/pr-manager/server/main.ts" \
      --set-default PR_MANAGER_WEB_DIR ${web} \
      --set-default PR_MANAGER_CLAUDE_PATH ${lib.getExe claude-code}
    makeWrapper ${nodejs_22}/bin/node $out/bin/pr-manager \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/pr-manager/server/cli.ts"
    runHook postInstall
  '';

  passthru = { inherit web; };

  meta = {
    description = "Dashboard and sticky Claude agent sessions for GitHub pull requests";
    mainProgram = "pr-manager";
    platforms = lib.platforms.linux;
  };
}
