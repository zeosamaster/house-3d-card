// The card's own words, in the viewer's Home Assistant language (English unless Portuguese).
const STR = {
  en: {
    lights: 'Lights', climate: 'Climate', covers: 'Doors & windows', media_players: 'Media', security: 'Security', others: 'Other',
    lightsOn: (n, of) => `${n} of ${of} on`, allOff: 'All off', turnOff: 'Turn off', turnOn: 'Turn on', undo: 'Undo',
    lightsOff: (n) => `${n} ${n === 1 ? 'light' : 'lights'} off`, house: 'House',
    roomNames: 'Room names', temps: 'Temperatures', everyOff: 'Turn off every light', roomOff: "Turn this room's lights off",
    noArea: 'This room is not linked to an HA area.', areaGone: 'Area not found.', loading: 'Loading…',
    starter: 'Starter layout from your HA areas — tap ✎ to arrange the rooms.', saved: 'Plan saved',
    home: 'home', away: 'away', done: 'done', error: 'error', min: 'min', editHouse: 'Edit house',
  },
  pt: {
    lights: 'Luzes', climate: 'Clima', covers: 'Portas e janelas', media_players: 'Multimédia', security: 'Segurança', others: 'Outros',
    lightsOn: (n, of) => `${n} de ${of} ${n === 1 ? 'ligada' : 'ligadas'}`, allOff: 'Tudo apagado', turnOff: 'Apagar', turnOn: 'Acender',
    undo: 'Desfazer', lightsOff: (n) => `${n} ${n === 1 ? 'luz apagada' : 'luzes apagadas'}`, house: 'Casa',
    roomNames: 'Nomes das divisões', temps: 'Temperaturas', everyOff: 'Apagar todas as luzes', roomOff: 'Apagar as luzes desta divisão',
    noArea: 'Esta divisão não está ligada a uma área do HA.', areaGone: 'Área não encontrada.', loading: 'A carregar…',
    starter: 'Planta inicial a partir das áreas do HA — toque em ✎ para arrumar as divisões.', saved: 'Planta guardada',
    home: 'em casa', away: 'fora', done: 'pronta', error: 'erro', min: 'min', editHouse: 'Editar casa',
  },
};

/** Strings for `hass`'s language; `override` (card `language:` option) wins. */
export function strings(hass, override) {
  const lang = String(override || hass?.locale?.language || hass?.language || 'en').toLowerCase();
  return STR[lang.slice(0, 2)] || STR.en;
}
