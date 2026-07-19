export interface CompanyWeightConfig { aliases: Record<string, string>; weights: Record<string, number>; }

const tier100 = ['Jane Street', 'HRT', 'Citadel', 'Citadel Securities', 'D. E. Shaw', 'Five Rings', 'Jump', 'IMC', 'Optiver', 'Two Sigma', 'OpenAI', 'Anthropic', 'Google', 'Meta', 'Apple', 'Microsoft', 'NVIDIA', 'Netflix'];
const tier80 = ['Amazon', 'Stripe', 'Databricks', 'Roblox', 'Palantir', 'Cloudflare', 'Snowflake', 'Coinbase', 'Figma', 'Notion', 'Ramp', 'Rippling', 'SpaceX', 'Tesla', 'Anduril', 'ByteDance', 'Bloomberg'];
const tier60 = ['Salesforce', 'Adobe', 'Uber', 'Airbnb', 'LinkedIn', 'Pinterest', 'DoorDash', 'Atlassian', 'Oracle', 'IBM', 'Datadog', 'MongoDB'];

export const companyWeights: CompanyWeightConfig = {
  aliases: {
    'deepmind': 'Google', 'google/deepmind': 'Google', 'tiktok': 'ByteDance',
    'citadel securities': 'Citadel Securities', 'hudson river trading': 'HRT',
    'jump trading': 'Jump', 'd. e. shaw': 'D. E. Shaw'
  },
  weights: Object.fromEntries([...tier100.map((x) => [x, 100]), ...tier80.map((x) => [x, 80]), ...tier60.map((x) => [x, 60])])
};

export function companyWeight(company: string, config = companyWeights): number {
  const simplified = company.trim().toLowerCase();
  const alias = config.aliases[simplified];
  const name = alias ?? Object.keys(config.weights).find((key) => key.toLowerCase() === simplified);
  return name ? config.weights[name] ?? 0 : 0;
}
