# Hover Translate

Extension Chrome (Manifest V3) : maintenez **Alt / Option ⌥** et survolez un mot. Une pop-up affiche :

- en titre, la **traduction du mot dans le sens de la phrase** (« bank » → *rive* au bord d'une rivière, *banque* pour un dépôt de salaire) ;
- en dessous, une **entrée de dictionnaire** : catégorie grammaticale, sens numérotés, exemples ;
- si le mot est déjà dans votre langue, sa **définition** au lieu d'une traduction.

![pop-up](docs/popup.png)

## Principe : l'IA de l'utilisateur

La traduction est entièrement faite par un LLM, avec les identifiants de l'utilisateur. L'extension ne passe par aucun serveur intermédiaire et ne coûte rien à son éditeur. Comme il faut obligatoirement un fournisseur, plusieurs sont proposés, dont des gratuits :

| Fournisseur | Accès | Modèle recommandé par défaut |
|---|---|---|
| **Google Gemini** | clé gratuite (compte Google) | `gemini-3.5-flash-lite` |
| **OpenRouter** | **connexion en 1 clic** (OAuth), modèles gratuits `:free` | `google/gemma-4-31b-it:free` |
| **OpenAI** | clé API (l'abonnement ChatGPT n'inclut pas l'API) | `gpt-5-mini` |
| **Anthropic Claude** | clé API (l'abonnement Claude n'inclut pas l'API) | `claude-haiku-5-5` |
| **Groq** | clé, offre gratuite, très rapide | `llama-3.3-70b-versatile` |
| **Mistral AI** | clé, offre « Experiment » gratuite | `mistral-small-latest` |
| **Hugging Face** | jeton « Inference Providers », crédits mensuels offerts | `google/gemma-4-31B-it` |

La liste des modèles est chargée depuis le fournisseur, avec le modèle recommandé en tête. Elle reste donc à jour quand les modèles changent.

Pour rester rapide :
- la réponse arrive **en streaming** ;
- le titre s'affiche **dès que la 1ʳᵉ ligne est complète**, jamais de traduction provisoire ;
- la « réflexion » des modèles est coupée quand c'est possible ;
- la requête est annulée dès que la souris passe à un autre mot ;
- les réponses sont mises en cache (mot + phrase).

## Langues

- **Source** : détectée sur la **phrase**, pas sur le mot seul (« pain », « chat » sont ambigus). La détection utilise le détecteur de langue intégré à Chrome, sur l'appareil ; à défaut, l'attribut `lang` de la page.
- **Destination** : « Automatique » (langue du navigateur) ou l'une des 43 langues courantes.

## Installation (mode développeur)

1. Ouvrez `chrome://extensions` et activez le **Mode développeur** (en haut à droite).
2. Cliquez sur **Charger l'extension non empaquetée** et choisissez ce dossier.
3. La page de réglages s'ouvre : choisissez un fournisseur, collez la clé (ou connectez-vous à OpenRouter), puis cliquez sur **Enregistrer et tester**.
4. **Rechargez** vos onglets déjà ouverts, maintenez Alt et survolez un mot.

Après une modification du code : ↻ sur la carte de l'extension, puis rechargez l'onglet.

## Utilisation

- **Alt maintenu + survol.** Vous pouvez relâcher : la pop-up reste tant que la souris est proche.
- **`Alt+Shift+T`** active le mode survol sans touche à tenir. Échap le désactive. Raccourci modifiable dans `chrome://extensions/shortcuts`.
- **Expression de plusieurs mots** : sélectionnez-la, puis survolez la sélection avec Alt.

## Tests

```bash
npm install
npx playwright install chromium
npm test
```

`test/e2e.mjs` charge l'extension dans un Chromium automatisé et vérifie 40 comportements :
- survol, rendu, absence de titre provisoire, cache, mode définition ;
- format des requêtes pour chaque type d'API, nouvel essai quand un modèle refuse les paramètres de vitesse ;
- page de réglages.

Les fournisseurs sont imités par un serveur local qui renvoie du streaming SSE. Une dernière série appelle **les 7 vrais fournisseurs avec une clé invalide**, pour prouver que l'extension les atteint et affiche un message clair. Les captures sont écrites dans `test/output/`.

## Structure

```
manifest.json
src/settings.js     fournisseurs, réglages, langues
src/background.js   service worker : appel LLM en streaming, cache, raccourci
src/content.js      détection du mot et de la langue, pop-up en Shadow DOM
src/options.*       page de réglages (choix du fournisseur, connexion OpenRouter)
```

## Limites connues

- Les champs de saisie et les PDF intégrés ne sont pas pris en charge ; les pages `chrome://` et le Chrome Web Store refusent les scripts d'extension.
- « Se connecter avec ChatGPT » (paiement via l'abonnement ChatGPT) est réservé à des partenaires d'OpenAI : à ajouter quand l'accès sera ouvert.
- Les clés sont stockées localement dans `chrome.storage.local`, sans synchronisation, et ne sont envoyées qu'au fournisseur choisi.
