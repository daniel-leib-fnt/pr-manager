{ lib, stdenvNoCC, fetchPnpmDeps, pnpmConfigHook, pnpm, nodejs_22, makeWrapper, claude-code }:

let
  # The pnpm workspace files every build needs; each derivation adds its own sources.
  workspace = [ ../package.json ../pnpm-lock.yaml ../pnpm-workspace.yaml ../web/package.json ];

  # Angular UI.
  web = stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "pr-manager-web";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions (
        workspace
        ++ [
          (lib.fileset.difference ../web (
            lib.fileset.unions (map lib.fileset.maybeMissing [ ../web/node_modules ../web/.angular ../web/dist ])
          ))
        ]
      );
    };
    pnpmWorkspaces = [ "web" ];
    pnpmDeps = fetchPnpmDeps {
      inherit (finalAttrs) pname version src pnpmWorkspaces;
      fetcherVersion = 4;
      hash = "sha256-xgxx6DuXP7WOJ5YEx3Hp2EkdSTS924q5s+wpHBEL+MQ=";
    };
    nativeBuildInputs = [ nodejs_22 pnpm pnpmConfigHook ];
    buildPhase = ''
      runHook preBuild
      pnpm --filter web exec ng build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      cp -r web/dist/web/browser $out
      runHook postInstall
    '';
  });
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pr-manager";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions (workspace ++ [ ../server ../prompts ]);
  };
  pnpmWorkspaces = [ "pr-manager" ];
  pnpmInstallFlags = [ "--prod" ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src pnpmWorkspaces pnpmInstallFlags;
    fetcherVersion = 4;
    hash = "sha256-vjHCvEXN5XizD9o13AmanL+sgeofDazPYVotDd7uEvY=";
  };
  nativeBuildInputs = [ nodejs_22 pnpm pnpmConfigHook makeWrapper ];

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
})
