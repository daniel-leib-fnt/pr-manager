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
    npmDepsHash = "sha256-XJUn77ApIMoQ6VGX0gKrLVrVRD6CDwLn3irgRHUEJnQ=";
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
  npmDepsHash = "sha256-0L7whIGRd5nX/i30AZWLCSRBwuQ3mKcWQdnt7OrUBzk=";
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
