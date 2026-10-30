self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.pr-manager;
  json = pkgs.formats.json { };
  settingsFile = json.generate "pr-manager-settings.json" cfg.settings;

  # Exports go through the shell, not Environment=: systemd strips quotes from values.
  # The Claude OAuth token is read from the Secret Service, so it never lands in the Nix store;
  # this fails while the keyring is locked, and systemd retries.
  start = pkgs.writeShellScript "pr-manager-start" ''
    set -eu
    token=$(${pkgs.libsecret}/bin/secret-tool lookup ${lib.escapeShellArgs cfg.tokenAttributes}) || {
      echo "pr-manager: Claude token not found in the Secret Service (${toString cfg.tokenAttributes}); is the keyring unlocked?" >&2
      exit 1
    }
    export CLAUDE_CODE_OAUTH_TOKEN="$token"
    export PR_MANAGER_PORT=${toString cfg.port}
    export PR_MANAGER_SETTINGS=${settingsFile}
    export PR_MANAGER_SRC_ROOT=${lib.escapeShellArg cfg.checkoutRoot}
    export PR_MANAGER_WORKTREE_DIR=${lib.escapeShellArg cfg.worktreeDir}
    export PR_MANAGER_STATE_DIR=${lib.escapeShellArg cfg.stateDir}
    exec ${cfg.package}/bin/pr-manager-daemon
  '';
in
{
  options.services.pr-manager = {
    enable = lib.mkEnableOption "pr-manager, the dashboard and agent runner for GitHub pull requests";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "pr-manager.packages.\${system}.default";
      description = "The pr-manager package.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8020;
      description = "Port of the dashboard on 127.0.0.1.";
    };

    checkoutRoot = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/SC/github";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/SC/github"'';
      description = "Where repositories are cloned, as <checkoutRoot>/<owner>/<repo>.";
    };

    worktreeDir = lib.mkOption {
      type = lib.types.str;
      default = "{clone}.worktrees/{branch}";
      description = ''
        Where PR worktrees go. Placeholders: {clone} (the clone path), {owner}, {repo}, and
        {branch} (the head branch with / replaced by -).
      '';
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.stateHome}/pr-manager";
      defaultText = lib.literalExpression ''"''${config.xdg.stateHome}/pr-manager"'';
      description = "Directory of the pr-manager database.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.jdk21_headless pkgs.pnpm ]";
      description = "Extra tools on the PATH of the daemon and its agent sessions, before the user and system profiles.";
    };

    settings = lib.mkOption {
      type = json.type;
      default = { };
      example = lib.literalExpression ''
        {
          pollIntervalMinutes = 5;
          reviewQuery = "is:pr is:open archived:false user-review-requested:@me";
          excludedRepos = [ "fntsoftware/fcp_fnt-command-platform" ];
          maxParallelSessions = 2;
        }
      '';
      description = ''
        Defaults for the behavior settings. Changes made on the dashboard's settings page override
        them until reset there. Keys: pollIntervalMinutes, pollDays (0 = Sunday), pollFromHour,
        pollToHour, ownQuery, reviewQuery, excludedRepos, reviewWaitForGreenBuild,
        autoFollowupOnReRequest, reviewGuidelines, smallChangeRubric, maxCiAttempts,
        batchQuietMinutes, resolveThreads ("fixed_and_skipped_with_reason", "fixed", "never"),
        replyHeader ({viewer} is replaced), autoRemoveMergedWorktrees, allowedTools,
        maxParallelSessions, model, maxTurns, maxBudgetUsd, notify ("input", "review_draft",
        "blocked", "error"). Unknown keys and invalid values are logged and ignored.
      '';
    };

    tokenAttributes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "service" "pr-manager" ];
      description = "Secret Service attributes (for `secret-tool lookup`) of the Claude OAuth token.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    systemd.user.services.pr-manager = {
      Unit = {
        Description = "pr-manager: GitHub pull request dashboard and agent runner";
        After = [ "graphical-session.target" ];
        StartLimitIntervalSec = 0;
      };
      Service = {
        ExecStart = "${start}";
        Environment = [
          # The daemon needs git, gh and notify-send; agent sessions also need the user's
          # toolchain (JDK, pnpm, ...), from extraPackages and the user and system profiles.
          "PATH=${lib.makeBinPath (cfg.extraPackages ++ [ pkgs.git pkgs.gh pkgs.libnotify pkgs.xdg-utils pkgs.coreutils pkgs.bash ])}:${config.home.profileDirectory}/bin:/run/current-system/sw/bin:/run/wrappers/bin"
        ];
        Restart = "on-failure";
        RestartSec = "60s";
        # Agent sessions run as child processes; stop them with the daemon.
        KillMode = "mixed";
        TimeoutStopSec = "15s";
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
