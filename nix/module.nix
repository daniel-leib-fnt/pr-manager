self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.pr-manager;

  # Reads the Claude OAuth token (from `claude setup-token`) from the Secret Service, so it never
  # lands in the Nix store. Fails while the keyring is locked; systemd retries.
  start = pkgs.writeShellScript "pr-manager-start" ''
    set -eu
    token=$(${pkgs.libsecret}/bin/secret-tool lookup ${lib.escapeShellArgs cfg.tokenAttributes}) || {
      echo "pr-manager: Claude token not found in the Secret Service (${toString cfg.tokenAttributes}); is the keyring unlocked?" >&2
      exit 1
    }
    export CLAUDE_CODE_OAUTH_TOKEN="$token"
    export PR_MANAGER_ALLOWED_TOOLS=${lib.escapeShellArg (builtins.toJSON cfg.allowedTools)}
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

    allowedTools = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "Read" "Glob" "Grep" "TodoWrite" "Bash(git *)" "Bash(./gradlew *)" "Bash(pnpm *)" "Bash(nix develop *)" ];
      description = ''
        Tools agent sessions may use without asking, in Claude Code permission rule syntax.
        Edits inside the worktree are always allowed. Everything else is denied and logged.
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
          "PR_MANAGER_PORT=${toString cfg.port}"
          # The daemon needs git, gh and notify-send; agent sessions also need the user's
          # toolchain (JDK, pnpm, ...), which comes from the user and system profiles.
          "PATH=${lib.makeBinPath [ pkgs.git pkgs.gh pkgs.libnotify pkgs.xdg-utils pkgs.coreutils pkgs.bash ]}:${config.home.profileDirectory}/bin:/run/current-system/sw/bin:/run/wrappers/bin"
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
