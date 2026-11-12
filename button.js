/**
 * Код кнопки из тестрейла
 */

name: Run Tests
description: Test how to work with it
  author: Gurock Software
version: 1.0
includes: ^runs/view
excludes:

  js:
    $(document).ready(
      function() {
        var api_url = 'https://plgiirczejbn0y5xfna8.<vs host>.ru/';
        //api_url = 'http://localhost:3000/';
        /* Create the button */
        var button = $('<div class="toolbar content-header-toolbar"><a class="toolbar-button toolbar-button-last toolbar-button-first content-header-button button-start" href="javascript:void(0)">Run Tests</a></div>');
        var disableButton = function() {
          $("a", button).addClass('toolbar-button-disabled button-add-disabled');
          $("a", button).attr('disabled','disabled');
          $("a", button).text('Test (in progress)');
        };
        var startCheck = function(firstCheck = false) {
          if (!firstCheck) {
            disableButton();
          }
          var ii = setInterval(function() {
            console.log('itnerval');
            $.ajax({
              url: api_url + 'check',
              jsonp: "callback",
              dataType: "jsonp",
              data: {
                data: JSON.stringify({id: uiscripts.context.run.id})
              },
              success: function(runned) {
                console.log(runned);
                if (!runned) {
                  clearInterval(ii);
                  if (!firstCheck) {
                    location.reload();
                  }
                } else {
                  disableButton();
                  firstCheck = false;
                }
              }
            });
          }, 5000);
        }

        /* Add it to the toolbar */
        $("#content-header .content-header-inner").prepend(button);
        startCheck(true);

        /* Bind the click event to trigger the automated tests */
        $("a", button).click(
          function()
          {
            uiscripts.checkedTests = {};
            $('td.checkbox input').each(function(i, c) {
              uiscripts.checkedTests[$(c).val()] = c.checked;
            });
            $.ajax({
              url: api_url,
              jsonp: "callback",
              dataType: "jsonp",
              data: {
                data: JSON.stringify(uiscripts)
              },
              success: function(data) {
                console.log(data);
                if (!data.alreadyStarted) {
                  startCheck();
                }
              }
            });

          });
      });