export interface GameEntry {
  name: string;
  category: string;
  description: string;
  image: string;
  eggUrl: string;
  startup: string;
  variables: Record<string, string>;
}

export const GAMES: GameEntry[] = [
  {
    name: 'Paper',
    category: 'Minecraft',
    description: 'High-performance Minecraft server with plugin support.',
    image: 'ghcr.io/pterodactyl/yolks:java_25',
    eggUrl: 'https://bitqate.com/eggs/egg-paper.json',
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
    variables: {
      SERVER_JARFILE: 'server.jar',
      MINECRAFT_VERSION: 'latest',
      BUILD_NUMBER: 'latest',
    },
  },
  {
    name: 'Vanilla',
    category: 'Minecraft',
    description: 'Official Minecraft server with no modifications.',
    image: 'ghcr.io/pterodactyl/yolks:java_25',
    eggUrl:
      'https://raw.githubusercontent.com/pterodactyl/panel/1.0-develop/database/Seeders/eggs/minecraft/egg-vanilla-minecraft.json',
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
    variables: { SERVER_JARFILE: 'server.jar', MINECRAFT_VERSION: 'latest' },
  },
  {
    name: 'LeafMC',
    category: 'Minecraft',
    description:
      'Performance fork based on Purpur & Gale. High TPS under heavy load.',
    image: 'ghcr.io/pterodactyl/yolks:java_25',
    eggUrl: 'https://bitqate.com/eggs/egg-leafmc.json',
    startup:
      'java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}}',
    variables: { SERVER_JARFILE: 'server.jar', MINECRAFT_VERSION: 'latest' },
  },
  {
    name: 'Forge',
    category: 'Modded Minecraft',
    description: 'Modded server using the Forge mod loader.',
    image: 'ghcr.io/pterodactyl/yolks:java_25',
    eggUrl: 'https://bitqate.com/eggs/egg-forge.json',
    startup:
      'java $([ -f user_jvm_args.txt ] && printf %s "@user_jvm_args.txt") -Xms128M -Xmx{{SERVER_MEMORY}}M $([ ! -f unix_args.txt ] && printf %s "-jar {{SERVER_JARFILE}}" || printf %s "@unix_args.txt") nogui',
    variables: {
      SERVER_JARFILE: 'server.jar',
      MINECRAFT_VERSION: 'latest',
      FORGE_VERSION: 'latest',
    },
  },
  {
    name: 'Fabric',
    category: 'Modded Minecraft',
    description: 'Modded server using the Fabric mod loader.',
    image: 'ghcr.io/pterodactyl/yolks:java_25',
    eggUrl: 'https://bitqate.com/eggs/egg-fabric.json',
    startup:
      'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
    variables: {
      SERVER_JARFILE: 'server.jar',
      MINECRAFT_VERSION: 'latest',
      LOADER_VERSION: 'latest',
    },
  },
  {
    name: 'Valheim',
    category: 'Survival',
    description: 'Viking survival game server.',
    image: 'ghcr.io/parkervcp/games:valheim',
    eggUrl:
      'https://raw.githubusercontent.com/pelican-eggs/eggs/master/game_eggs/steamcmd_servers/valheim/valheim_vanilla/egg-valheim.json',
    startup:
      './valheim_server.x86_64 -name "{{SERVER_NAME}}" -port {{SERVER_PORT}} -world "{{WORLD}}" -password "{{PASSWORD}}" -public {{PUBLIC_SERVER}}',
    variables: {
      SERVER_NAME: 'My Valheim Server',
      WORLD: 'Dedicated',
      PASSWORD: '',
      PUBLIC_SERVER: '1',
    },
  },
  {
    name: 'Rust',
    category: 'Rust',
    description: 'Survive, build, and raid in a harsh open world.',
    image: 'ghcr.io/pterodactyl/games:rust',
    eggUrl:
      'https://raw.githubusercontent.com/pelican-eggs/eggs/master/game_eggs/steamcmd_servers/rust/rust_autowipe/egg-rust-autowipe.json',
    startup:
      './RustDedicated -batchmode +server.port {{SERVER_PORT}} +server.identity "rust" +rcon.port {{RCON_PORT}} +rcon.password "{{RCON_PASS}}" +rcon.web true +server.hostname "{{HOSTNAME}}" +server.maxplayers {{MAX_PLAYERS}} +server.worldsize {{WORLD_SIZE}} +server.seed {{WORLD_SEED}} +server.saveinterval {{SAVEINTERVAL}}',
    variables: {
      HOSTNAME: 'A Rust Server',
      MAX_PLAYERS: '40',
      WORLD_SIZE: '3000',
      WORLD_SEED: '0',
      RCON_PORT: '28016',
      RCON_PASS: 'CHANGEME',
      SAVEINTERVAL: '60',
    },
  },
  {
    name: 'ARK: Survival Evolved',
    category: 'ARK',
    description: 'Tame dinosaurs and survive on a mysterious island.',
    image: 'ghcr.io/parkervcp/games:source',
    eggUrl:
      'https://raw.githubusercontent.com/pelican-eggs/eggs/master/game_eggs/steamcmd_servers/ark_survival_evolved/egg-ark--survival-evolved.json',
    startup:
      './ShooterGame/Binaries/Linux/ShooterGameServer {{SERVER_MAP}}?listen?SessionName="{{SESSION_NAME}}"?ServerPassword={{ARK_PASSWORD}}?ServerAdminPassword={{ARK_ADMIN_PASSWORD}}?Port={{SERVER_PORT}}?RCONPort={{RCON_PORT}}?QueryPort={{QUERY_PORT}}?RCONEnabled=True?MaxPlayers={{MAX_PLAYERS}} -server -automanagedmods -log',
    variables: {
      SESSION_NAME: 'A BitQate Hosted ARK Server',
      SERVER_MAP: 'TheIsland',
      ARK_PASSWORD: '',
      ARK_ADMIN_PASSWORD: 'PleaseChangeMe',
      MAX_PLAYERS: '12',
      RCON_PORT: '27020',
      QUERY_PORT: '27015',
    },
  },
  {
    name: 'Project Zomboid',
    category: 'ProjectZomboid',
    description: 'Isometric zombie survival sandbox.',
    image: 'ghcr.io/parkervcp/steamcmd:debian',
    eggUrl:
      'https://raw.githubusercontent.com/pelican-eggs/eggs/master/game_eggs/steamcmd_servers/project_zomboid/egg-project-zomboid.json',
    startup:
      'export PATH="./jre64/bin:$PATH" ; export LD_LIBRARY_PATH="./linux64:./natives:.:./jre64/lib/amd64:${LD_LIBRARY_PATH}" ; ./ProjectZomboid64 -port {{SERVER_PORT}} -udpport {{STEAM_PORT}} -servername "{{SERVER_NAME}}" -adminusername "{{ADMIN_USER}} -adminpassword "{{ADMIN_PASSWORD}}"',
    variables: {
      SERVER_NAME: 'BitQate',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: '',
      STEAM_PORT: '16262',
      MAX_PLAYERS: '10',
    },
  },
  {
    name: 'Counter-Strike 2',
    category: 'CSGO',
    description: 'Competitive tactical shooter, the next chapter of CS:GO.',
    image: 'ghcr.io/ptero-eggs/steamcmd:sniper',
    eggUrl:
      'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/counter_strike/counter_strike_2/egg-counter--strike2.json',
    startup:
      'LD_LIBRARY_PATH="$HOME/game/bin/linuxsteamrt64:$LD_LIBRARY_PATH" ./game/bin/linuxsteamrt64/cs2 -dedicated $( [ "$VAC_ENABLED" == "1" ] || printf %s \' -insecure\' ) -ip 0.0.0.0 -port {{SERVER_PORT}} -tv_port {{TV_PORT}} -maxplayers {{MAX_PLAYERS}} $( [ "$RCON_ENABLED" == "0" ] || printf %s \' -usercon\' ) +game_mode {{GAME_MODE}} +game_type {{GAME_TYPE}} +map {{SRCDS_MAP}} +hostname "{{SERVER_NAME}}" +sv_password "{{SERVER_PASSWORD}}" +rcon_password "{{RCON_PASSWORD}}" +sv_setsteamaccount {{STEAM_GSLT}}',
    variables: {
      SRCDS_MAP: 'de_dust2',
      MAX_PLAYERS: '12',
      TV_PORT: '27020',
      STEAM_GSLT: '',
      SERVER_NAME: 'A BitQate hosted CS2 Server',
      SERVER_PASSWORD: '',
      RCON_PASSWORD: '',
      GAME_MODE: '1',
      GAME_TYPE: '0',
    },
  },
  {
    name: "Garry's Mod",
    category: 'GMod',
    description: 'Sandbox physics playground built on the Source engine.',
    image: 'ghcr.io/ptero-eggs/games:source',
    eggUrl:
      'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/gmod/egg-garry-s-mod.json',
    startup:
      './srcds_run -game garrysmod -console -port {{SERVER_PORT}} +ip 0.0.0.0 +host_workshop_collection {{WORKSHOP_ID}} +map {{SRCDS_MAP}} +gamemode {{GAMEMODE}} -strictportbind -norestart +sv_setsteamaccount {{STEAM_TOKEN}} +maxplayers {{MAX_PLAYERS}} -tickrate {{TICKRATE}} $( [ "$LUA_REFRESH" == "1" ] || printf %s \'-disableluarefresh\' )',
    variables: {
      SRCDS_MAP: 'gm_flatgrass',
      STEAM_TOKEN: '',
      WORKSHOP_ID: '',
      GAMEMODE: 'sandbox',
      MAX_PLAYERS: '32',
      TICKRATE: '22',
      LUA_REFRESH: '0',
    },
  },
  {
    name: 'Terraria',
    category: 'Terraria',
    description: '2D sandbox adventure with building and boss fights.',
    image: 'ghcr.io/parkervcp/yolks:debian',
    eggUrl:
      'https://raw.githubusercontent.com/pelican-eggs/eggs/master/game_eggs/terraria/vanilla/egg-terraria-vanilla.json',
    startup:
      './TerrariaServer.bin.x86_64 -world "{{WORLD_NAME}}" -port {{SERVER_PORT}} -maxplayers {{MAX_PLAYERS}} -worldsize {{WORLD_SIZE}} -difficulty {{WORLD_DIFFICULTY}} -motd "{{SERVER_MOTD}}"',
    variables: {
      WORLD_NAME: 'world',
      MAX_PLAYERS: '8',
      WORLD_SIZE: '3',
      WORLD_DIFFICULTY: '3',
      SERVER_MOTD: 'Welcome!',
    },
  },
];

export function findGame(name: string): GameEntry | undefined {
  const n = name.toLowerCase();
  return (
    GAMES.find((g) => g.name.toLowerCase() === n) ??
    GAMES.find((g) => g.name.toLowerCase().includes(n))
  );
}
