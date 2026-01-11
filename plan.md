# Plan de Migration CCSeva vers z.ai API

## Contexte

CCSeva utilise actuellement le package `ccusage` npm qui lit les fichiers JSONL dans `~/.claude` pour récupérer les données d'usage d'Anthropic Claude. L'objectif est de remplacer cette source de données par l'API z.ai.

## Analyse des sources

### API z.ai (depuis test_zai_api.py)

**Base URL**: `https://api.z.ai`

**Authentification**:
- Header: `authorization: Bearer {token}`
- Token depuis variable d'environnement: `ANTHROPIC_AUTH_TOKEN`

**Endpoints disponibles**:

1. **GET /api/monitor/usage/quota/limit**
   - Retourne les limites d'utilisation
   - Réponse contient `limits` avec `TIME_LIMIT` et `TOKENS_LIMIT`
   - `TOKENS_LIMIT` contient:
     - `usage`: limite totale (ex: 40000000)
     - `currentValue`: tokens utilisés
     - `remaining`: tokens restants
     - `percentage`: pourcentage utilisé
     - `nextResetTime`: timestamp du prochain reset

2. **GET /api/monitor/usage/model-usage**
   - Paramètres: `startTime`, `endTime` (format: "YYYY-MM-DD HH:MM:SS")
   - Retourne:
     - `totalUsage.totalModelCallCount`: nombre total d'appels
     - `totalUsage.totalTokensUsage`: tokens totaux utilisés
     - `x_time`: tableau des timestamps horaires
     - Données horaires pour les graphiques

3. **GET /api/monitor/usage/tool-usage**
   - Retourne l'usage des outils (search, web-reader, zread, etc.)

4. **GET /api/monitor/usage/model-performance-day**
   - Retourne les statistiques de performance quotidiennes
   - Vitesse de décodage (lite, promax)
   - Taux de succès

### Structures CCSeva actuelles

**Service**: `CCUsageService` dans `src/services/ccusageService.ts`
- Utilise `loadSessionBlockData()` et `loadDailyUsageData()` de `ccusage/data-loader`
- Retourne `UsageStats` avec:
  - `today`, `thisWeek`, `thisMonth`: DailyUsage[]
  - `tokensUsed`, `tokenLimit`, `percentageUsed`
  - `velocity`, `prediction`, `resetInfo`
  - `sessionTracking`: sessions de 5 heures

**Types**: `src/types/usage.ts`
- `UsageStats`, `DailyUsage`, `MenuBarData`
- `VelocityInfo`, `PredictionInfo`, `ResetTimeInfo`
- `SessionTracking`, `SessionWindow`, `SessionInfo`

---

## Tâches de Migration

### Phase 1: Création du Service Z.ai

#### 1.1 Créer le service ZAIService
**Fichier**: `src/services/zaiService.ts`

**Responsabilités**:
- Remplacer `CCUsageService` pour la récupération des données
- Implémenter les appels HTTP vers l'API z.ai
- Gérer le cache (comme CCUsageService avec CACHE_DURATION)
- Mapper les réponses z.ai vers les structures TypeScript existantes

**Méthodes à implémenter**:
```typescript
class ZAIService {
  // Configuration
  private apiKey: string;
  private baseUrl: string = "https://api.z.ai";
  private cachedStats: UsageStats | null = null;
  private lastUpdate = 0;
  private readonly CACHE_DURATION = 30000; // 30 secondes

  // Méthodes principales
  async getUsageStats(): Promise<UsageStats>
  async getMenuBarData(): Promise<MenuBarData>

  // Méthodes API privées
  private async fetchQuotaLimit(): Promise<QuotaLimitResponse>
  private async fetchModelUsage(startTime: string, endTime: string): Promise<ModelUsageResponse>
  private async fetchToolUsage(startTime: string, endTime: string): Promise<ToolUsageResponse>

  // Méthodes de mapping
  private mapZaiToUsageStats(quota: QuotaLimit, modelUsage: ModelUsage): UsageStats
  private mapZaiToDailyUsage(modelUsage: ModelUsage): DailyUsage[]
  private calculateVelocity(hourlyData: HourlyData[]): VelocityInfo
  private calculatePrediction(tokensUsed: number, tokenLimit: number, velocity: VelocityInfo): PredictionInfo
}
```

**Interfaces à définir** (basées sur les réponses z.ai):
```typescript
interface ZaiQuotaLimit {
  type: string;
  unit: number;
  number: number;
  usage: number;
  currentValue: number;
  remaining: number;
  percentage: number;
  nextResetTime?: number;
}

interface ZaiQuotaResponse {
  code: number;
  msg: string;
  data: {
    limits: ZaiQuotaLimit[];
  };
  success: boolean;
}

interface ZaiModelUsageResponse {
  code: number;
  data: {
    totalUsage: {
      totalModelCallCount: number;
      totalTokensUsage: number;
    };
    x_time: string[];
    // autres champs horaires...
  };
  success: boolean;
}
```

#### 1.2 Gestion de l'authentification
- Lire `ANTHROPIC_AUTH_TOKEN` depuis les variables d'environnement
- Alternative: lire depuis un fichier de config CCSeva
- Gérer les erreurs d'authentification (401, 403)

### Phase 2: Adaptation des Types

#### 2.1 Étendre les types existants
**Fichier**: `src/types/usage.ts`

Les types existants sont largement compatibles, mais quelques ajustements peuvent être nécessaires:

- `DailyUsage`: Adapter pour z.ai (pas de coût en $, que des tokens)
- `UsageStats`:
  - `totalCost`: Peut être calculé différemment ou mis à 0
  - `currentPlan`: Les plans z.ai sont différents (TIME_LIMIT, TOKENS_LIMIT)

#### 2.2 Nouveau type pour les limites z.ai
```typescript
interface ZaiLimitConfig {
  type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
  unit: number;  // minutes pour TIME, jours pour TOKENS
  number: number; // quantité d'unités
  usage: number;  // limite totale
  currentValue: number;
  remaining: number;
  percentage: number;
  nextResetTime?: number; // timestamp
}
```

### Phase 3: Intégration dans l'Application

#### 3.1 Modifier main.ts
- Remplacer l'import et l'instanciation de `CCUsageService` par `ZAIService`
- Garder le même intervalle de polling (30 secondes)
- Maintenir la compatibilité IPC

#### 3.2 Mettre à jour les composants UI

**Composants à vérifier/adapter**:

1. **Dashboard.tsx**
   - Affichage des limites (TIME_LIMIT vs TOKENS_LIMIT)
   - Affichage des deux types de limites si nécessaire

2. **Analytics.tsx**
   - Graphiques utilisant `thisWeek`, `thisMonth`
   - Adapter aux données horaires z.ai

3. **TerminalView.tsx**
   - Affichage des infos de session
   - Adapter au format z.ai

4. **SettingsPanel.tsx**
   - Plans: Remplacer Pro/Max5/Max20 par les configurations z.ai
   - Ou supprimer la sélection de plan si z.ai gère cela automatiquement

### Phase 4: Calculs et Métriques

#### 4.1 Adapter le calcul de velocity
- CCSeva actuel: Calculé depuis les sessions de 5h
- z.ai: Utiliser les données horaires de `/model-usage`
- Conserver la logique de trend (increasing/decreasing/stable)

#### 4.2 Adapter le reset time
- z.ai fournit `nextResetTime` en timestamp
- Utiliser directement cette valeur
- Formater pour l'affichage

#### 4.3 Gestion des coûts
- z.ai ne fournit pas de coûts en $
- Option 1: Masquer les coûts -> retenu, si utilisation de z.ai
- Option 2: Calculer un coût estimé si nécessaire -> non

### Phase 5: Gestion des Erreurs

#### 5.1 Erreurs API
- 401/403: Token invalide → Afficher erreur dans UI
- 429: Rate limit → Attendre avant prochaine requête
- 500+: Erreur serveur → Fallback sur données cached ou mock

#### 5.2 Cache et fallback
- Conserver le cache de 30 secondes
- Si API indisponible, utiliser les dernières données connues
- Afficher un indicateur de "données périmées" si cache > 5 min

### Phase 6: Configuration

#### 6.1 Paramètres de configuration
- Ajouter une option pour choisir la source de données (z.ai vs ccusage)
- Permettre la configuration de l'API key dans les settings

#### 6.2 Documentation
- Mettre à jour README.md
- Documenter la configuration nécessaire

---

## Ordre Suggéré d'Implémentation

1. **Créer ZAIService** avec les méthodes de base
2. **Implémenter fetchQuotaLimit** et mapper vers UsageStats basique
3. **Implémenter fetchModelUsage** pour les données historiques
4. **Adapter les calculs** (velocity, prediction)
5. **Intégrer dans main.ts** (remplacer CCUsageService)
6. **Tester l'application** avec l'API z.ai réelle
7. **Adapter l'UI** si nécessaire pour les différences de données
8. **Gérer les erreurs** et edge cases
9. **Nettoyer le code** et documenter

---

## Risques et Considérations

### Risques
- **API key management**: Où stocker le token z.ai?
- **Rate limiting**: L'API z.ai a-t-elle des limites?
- **Disponibilité**: Que faire si l'API est down?
- **Format de données**: Différences structurelles importantes?

### Considérations
- **Maintenir la compatibilité**: Garder les mêmes types TypeScript autant que possible
- **Performance**: Ne pas faire trop d'appels API
- **Cache**: Essentiel pour éviter de surcharger l'API
- **Fallback**: Prévoir un mode dégradé si API indisponible

---

## Checklist Finale

- [ ] ZAIService créé avec toutes les méthodes nécessaires
- [ ] Appels API vers z.ai fonctionnels
- [ ] Mapping des réponses z.ai vers UsageStats
- [ ] Velocity et prediction calculés correctement
- [ ] Intégration dans main.ts
- [ ] UI adaptée si nécessaire
- [ ] Gestion d'erreurs robuste
- [ ] Tests manuels effectués
- [ ] Documentation mise à jour
