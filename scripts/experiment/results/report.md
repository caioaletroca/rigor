# Quality Experiment Results

Generated: 2026-07-21T00:08:57Z
Runs: 6 of 6

## Comparison Table

| Check             | Gemma4 W | Gemma4 W/O | Qwen3 W | Qwen3 W/O | Deepseek W | Deepseek W/O |
| ------------------ | :------: | :--------: | :-----: | :-------: | :--------: | :----------: |
| Builds            | N        | Y          | Y       | Y         | Y          | Y            |
| Test file exists  | Y        | N          | N       | N         | Y          | Y            |
| Tests pass        | N        | Y          | Y       | Y         | Y          | Y            |
| Coverage >= 85%   | N        | N          | N       | N         | N          | N            |
| Lint clean        | N        | Y          | Y       | Y         | Y          | Y            |
| Tool registers    | Y        | N          | N       | N         | Y          | Y            |
| Handler pattern   | N        | N          | N       | N         | Y          | Y            |
| Test pattern      | Y        | N          | N       | N         | Y          | Y            |
| Reads history dir | N        | N          | N       | N         | Y          | Y            |
| Edge cases        | N        | N          | N       | N         | Y          | Y            |
| **Total**             | **3**        | **3**          | **3**       | **3**         | **9**          | **9**            |

## Impact Analysis

| Model    | With Rigor | Without Rigor | Delta | Improvement |
| --------- | :--------: | :-----------: | :---: | :---------: |
| Gemma4   | 3/10       | 3/10          | +0    | +0%         |
| Qwen3    | 3/10       | 3/10          | +0    | +0%         |
| Deepseek | 9/10       | 9/10          | +0    | +0%         |
| **Average**  | **5.0**        | **5.0**           | **+0.0**  | **+0%**         |

## Summary

- **Highest scorer**: Deepseek with-rigor at 9/10.
- **Consistency**: with-rigor and without-rigor performed equally overall (0 wins, 0 losses, 3 ties).
- **Checks improved by gates**: Test file exists (1 model), Tool registers (1 model), Test pattern (1 model).

