// Loads the bundled JSON files in config/ and merges in user overrides from settings.
import { getSettings } from './settings.js';

const cache = {};

export function loadConfig(name) {
  cache[name] ??= fetch(chrome.runtime.getURL(`config/${name}.json`))
    .then((r) => r.json())
    .catch((e) => { delete cache[name]; throw e; });
  return cache[name];
}

export async function getTokenFactoryConfig() {
  const [cfg, settings] = await Promise.all([loadConfig('tokenfactory'), getSettings()]);
  return {
    ...cfg,
    baseUrl: (settings.baseUrl || cfg.baseUrl).replace(/\/+$/, ''),
    apiKey: settings.apiKey,
  };
}

// Model for a feature, from config taskModels (default: lightning).
export function modelFor(cfg, feature) {
  const key = cfg.taskModels?.[feature] ?? 'lightning';
  return cfg.models[key];
}

export async function getSiteCatalogue(site) {
  const models = await loadConfig('models');
  return models.sites[site]?.models ?? [];
}

// { mode: 'free' | 'codes', rules } - see config/models.json
export async function getEvaluateConfig() {
  const { evaluateMode, rules } = await loadConfig('models');
  return { mode: evaluateMode ?? 'free', rules };
}

// Map the text shown in a site's model picker (e.g. "Opus 5.5") to a catalogue entry. Full names first,
// longest first ("Opus 5.5" before "Opus 5"); a family alias ("opus") only if no name matches.
export function resolveModel(catalogue, pickerLabel) {
  if (!pickerLabel) return null;
  const text = pickerLabel.toLowerCase();
  return (
    [...catalogue].sort((a, b) => b.label.length - a.label.length).find((m) => text.includes(m.label.toLowerCase())) ??
    catalogue.find((m) => m.aliases?.some((a) => text.includes(a))) ??
    null
  );
}
