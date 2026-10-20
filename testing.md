# Initial Testing results

This was done with a third variant, inception (tested 10/20/2026), which is also a context management attempt.  

All tests were done with Qwen3.8:27b, which is the best model I've found for use with memento (inception ran on autobot/auto).   



## First test

### goal.md:

```
# Goal
develop a fastapi todo list app that is publicly available and editable.
Users should be able to create and destroy lists.
This should be able to display multiple lists, and items should be draggable between lists.
this should run in its own venv, and be served on port 8000.
```

Memento and normal both completed this in one shot with no bugs; inception has not been tested on the first prompt yet.  

|                                    | memento              | inception         | normal     |
| ---------------------------------- | --------------------:| -----------------:| ----------:|
| Assistant turns                    | 13                   | —                 | 16         |
| Tool results / calls               | 15 / 15              | —                 | 17 / 17    |
| Compactions                        | 5 (≈1 per 2.6 turns) | —                 | 0          |
| ↑ input tokens                     | 27k                  | —                 | 10k        |
| ↓ output tokens                    | 14k                  | —                 | 18k        |
| R cache-read tokens                | 157k                 | —                 | 309k       |
| **Total tokens (↑+↓+R)**           | **≈198k**            | —                 | **≈337k**  |
| Avg context per turn ((↑+R)/turns) | ≈14.2k               | —                 | ≈19.9k     |
| **Est. cost**                      | **$0.065**           | —                 | **$0.078** |

*Cost = ↑×$0.45/M + ↓×$3.20/M + R×$0.05/M (assumed Qwen3.8:27b prices). Inception ran on autobot/auto; the same formula is applied for comparability, though its reported session cost was $0.00.*

## Second Test

### goal.md:

```
develop a fastapi todo list app.
This should have a login system, along with an sqlite database.
Users should be able to create and destroy lists.
This should be able to display multiple lists, and items should be draggable between lists.
Items should have a checkbox.
Items should have customizable colors.
Lists should have customizable colors.
this should run in its own venv, and be served on port 8002.
```

Normal and inception both completed this in one shot with no errors.  Memento had a minor bug, which was fixed in one additional user request.  

### first run summary:

|                                    | memento              | inception           | normal     |
| ---------------------------------- | --------------------:| -------------------:| ----------:|
| Assistant turns                    | 17                   | 12                  | 39         |
| Tool results / calls               | 31 / 31              | 15 / 15             | 38 / 38    |
| Compactions                        | 7 (≈1 per 2.4 turns) | 3 (1 per 4 turns)   | 0          |
| ↑ input tokens                     | 98k                  | 68k                 | 57k        |
| ↓ output tokens                    | 46k                  | 27k                 | 41k        |
| R cache-read tokens                | 247k                 | 201k                | 1.4M       |
| **Total tokens (↑+↓+R)**           | **≈391k**            | **≈296k**           | **≈1.5M**  |
| Avg context per turn ((↑+R)/turns) | ≈20.3k               | ≈22.4k              | ≈37.4k     |
| **Est. cost**                      | **$0.204**           | **$0.127**          | **$0.227** |

### After bugfixes:

|                                                                          | memento               | inception           | normal     |
| ------------------------------------------------------------------------ | ---------------------:| -------------------:| ----------:|
| Assistant turns                                                          | 30                    | 12                  | 39         |
| Tool results / calls                                                     | 43 / 43               | 15 / 15             | 38 / 38    |
| Compactions                                                              | 12 (≈1 per 2.5 turns) | 3 (1 per 4 turns)   | 0          |
| ↑ input tokens                                                           | 132k                  | 68k                 | 57k        |
| ↓ output tokens                                                          | 58k                   | 27k                 | 41k        |
| R cache-read tokens                                                      | 413k                  | 201k                | 1.4M       |
| **Total tokens (↑+↓+R)**                                                 | **≈603k**             | **≈296k**           | **≈1.5M**  |
| Avg context per turn ((↑+R)/turns)                                       | ≈18.2k                | ≈22.4k              | ≈37.4k     |
| **Est. cost**                                                            | **$0.266**            | **$0.127**          | **$0.227** |
| *Inception and normal are identical to their first runs (no bugs found).* |                       |                     |            |



### notes:

These are far from exhaustive tests, and much more playing around is necessary.   But it's promising.  I think this would benefit greatly with fine tuning to improve 'note-taking' skills.  

Also, this is probably not an approach you should take all the time, but for some oddly shaped work requirements this could be very appealing.  Memento in particular is well suited to any job that requires some form of looping, which a normal LLM simply doesn't do.  

And the fact that it didn't incur a cost penalty compared to the 'normal' run is encouraging.  


