# Gates: 5 feature pack (plugins, spacing, pinning, groups, room chat)

Scope: Verify all 5 features landed and build passes.

- [x] G1: PluginsPanel has Marketplace/Yours tabs + Featured/Agent Orchestration sections
  CHECK: findstr /C:"Marketplace" src\components\PluginsPanel.tsx
  EXPECT: Marketplace
  EVIDENCE: ["marketplace", polish ? "Marketplace" : "Marketplace"], | /* ── Marketplace — sekcje z Show more, 2-kolumnowa siatka ── */

- [x] G2: PluginsPanel has Show more toggles
  CHECK: findstr /C:"Show" src\components\PluginsPanel.tsx
  EXPECT: Show
  EVIDENCE: /* ── Marketplace — sekcje z Show more, 2-kolumnowa siatka ── */ | {polish ? `Pokaż ${hidden} więcej` : `Show ${hidden} more`}

- [x] G3: Sidebar has pinned tray above agents under search (key `pin-` prefix)
  CHECK: findstr /C:"pin-" src\components\Sidebar.tsx
  EXPECT: pin-
  EVIDENCE: <BotListItem key={`pin-${b.id}`} bot={b} onMenu={setMenu} collapsed={collapsed} />

- [x] G4: Sidebar has LocalGroupsSection with collapse
  CHECK: findstr /C:"LocalGroupsSection" src\components\Sidebar.tsx
  EXPECT: LocalGroupsSection
  EVIDENCE: function LocalGroupsSection({ | <LocalGroupsSection bots={groupBots} onMenu={setMenu} collapsed={collapsed} />

- [x] G5: RoomPanel has clickable bot name pill
  CHECK: findstr /C:"openBot" src\components\RoomPanel.tsx
  EXPECT: openBot
  EVIDENCE: const openBot = (botId: string) => { | onClick={() => openBot(entry.from)}

- [x] G6: Composer avatar larger no border higher position
  CHECK: findstr /C:"-top-11" src\components\Composer.tsx
  EXPECT: -top-11
  EVIDENCE: <div className="absolute -top-11 left-2 z-20 flex size-11 items-center justify-center" title={bot.name}>

- [x] G7: Build passes after all changes
  CHECK: npm run build --silent
  EXPECT: built in
  EVIDENCE: - Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks | - Adjust chunk size limit for this warning via build.chunkSizeWarni
