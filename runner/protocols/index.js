import * as v2 from './dailyred-conf-v2+status-v1.js';

const REGISTRY = {
  [v2.PROTOCOL_ID]: v2,
};

export function listProtocolIds() {
  return Object.keys(REGISTRY);
}

export function getProtocolAdapter(protocolId) {
  const adapter = REGISTRY[protocolId];
  if (!adapter) {
    const known = listProtocolIds().join(', ') || '(ninguno)';
    throw new Error(
      `Protocolo desconocido «${protocolId}». Este launcher habla: ${known}. Actualiza Hortelano's Daily.`,
    );
  }
  return adapter;
}

export function hasProtocolAdapter(protocolId) {
  return Boolean(REGISTRY[protocolId]);
}
