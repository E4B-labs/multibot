// multibot: nadawca wiadomości bot→bot jako plakietka z awatarem, w miejscu
// dawnego „@Nazwa:". Dymek roli „user" leci czystym tekstem, nie markdownem,
// więc wtyczka wzmianek z ChatMarkdown nigdy się w nim nie odpalała i nazwa
// zostawała surowa — stąd osobny komponent zamiast polegania na wzmiankach.
//
// Styl celowo ten sam co pigułka wzmianki w ChatMarkdown: to ma być ten sam
// obiekt wizualny, tylko postawiony inną drogą.
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { normalizeState } from "@/lib/mascot";
import { botDisplayName } from "@/lib/botNames";
import { MausAvatar } from "./Avatar";

export function PeerBadge({ name }: { name: string }) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  // Nadawca bywa botem, którego już nie ma — wtedy zostaje sama nazwa
  // z koperty, bez awatara, zamiast pustego miejsca.
  const bot = state.bots.find((b) => b.name.toLowerCase() === name.toLowerCase());
  return (
    <span className="mr-1.5 inline-flex translate-y-px items-center gap-1 rounded-full bg-raised px-2 py-0.5 align-middle text-[13px] font-medium text-ink">
      {bot && (
        <MausAvatar
          color={bot.color}
          shape={bot.mascotShape}
          state={normalizeState(bot.mascotExpression) ?? "happy"}
          size={16}
          animated={false}
        />
      )}
      {bot ? botDisplayName(bot, polish ? "pl" : "en") : name}
    </span>
  );
}
